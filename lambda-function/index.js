/**
 * AKTO Bedrock Log Processor — entry point.
 *
 * Runs two independent pipelines in one Lambda, each with its own manifest
 * and time-budget checks:
 *   - Bedrock Agent Classic: reads S3 model-invocation logs (discovery.js,
 *     s3Logs.js, extractors.js, manifest.js).
 *   - AgentCore Harness/Runtime: reads CloudWatch observability traces
 *     instead of S3 (traceDiscovery.js, logGroupReader.js, traceParser.js,
 *     traceManifest.js) — a Harness/Runtime never appears in the S3 pipeline.
 */
const config = require('./config');
const { getManifest, updateManifest } = require('./manifest');
const { openLogFileCursor, processLogFile, resetLogStats, getLogStats } = require('./s3Logs');
const { resolveBedrockLogLocation } = require('./bedrockDelivery');
const { discoverAllNewAgents, rebuildRoleMapFromDiscoveredAgents, resetRunLogState, getIdentityStats } = require('./discovery');
const { sendToDataIngestionService } = require('./aktoClient');

const {
    discoverNewResources, initializeHarnessCache: initializeTraceHarnessCache, backfillExecutionRoleArns,
    buildRoleNameToResourceMap, buildHarnessNameToResourceMap, createStandardMessage: createTraceStandardMessage
} = require('./traceDiscovery');
const { discoverObservabilityLogGroups, readNewLogEventsInChunks } = require('./logGroupReader');
const { classifyRecord, parseLogRecord, resolveTraceIdentity, resolveTraceContent, buildConversationPair } = require('./traceParser');
const { getTraceManifest, updateTraceManifest } = require('./traceManifest');
const { acquireRunLock } = require('./runLock');

let traceHarnessInitialized = false;

/** Logs current heap/RSS usage — cheap visibility into memory pressure without waiting for the final Lambda REPORT line. */
function logMemory(label) {
    const { heapUsed, rss } = process.memoryUsage();
    console.log(`🧠 [${label}] heapUsed=${(heapUsed / 1048576).toFixed(0)}MB rss=${(rss / 1048576).toFixed(0)}MB`);
}

/**
 * Prints the configuration actually in effect. Most "it found nothing" reports come
 * down to a bucket, prefix, or endpoint being different from what was assumed —
 * having it in the log removes a round trip. Never prints the API key.
 */
function logEffectiveConfig() {
    let ingestHost = 'unset';
    try {
        ingestHost = new URL(config.DATA_INGESTION_ENDPOINT).host;
    } catch { /* leave as unset — validateConfig will have already failed on a blank value */ }

    // In stackset mode the bucket is discovered from this account's own logging
    // configuration and is not known yet; it is printed once resolved.
    const logsSource = config.LOGS_BUCKET_NAME
        ? `s3://${config.LOGS_BUCKET_NAME}/${config.LOGS_PREFIX}`
        : `discovered per account (${config.BEDROCK_LOGGING_MODE} mode)`;

    console.log('⚙️ Effective configuration:');
    console.log(`  ├─ build               ${config.CODE_VERSION}`);
    console.log(`  ├─ deployment          ${config.DEPLOYMENT_MODE}`);
    console.log(`  ├─ region              ${config.AWS_REGION} (account ${config.AWS_ACCOUNT_ID})`);
    console.log(`  ├─ bedrock logs        ${logsSource}`);
    console.log(`  ├─ checkpoints         s3://${config.MARKERS_BUCKET_NAME}/${config.MARKERS_PREFIX}`);
    console.log(`  ├─ agentcore logs      ${config.RUNTIME_LOG_GROUP_PREFIX}*`);
    console.log(`  ├─ akto ingest host    ${ingestHost} (api key ${config.AKTO_API_KEY ? 'set' : 'MISSING'})`);
    console.log(`  ├─ lookback            ${config.LOOKBACK_DAYS}d on a first run, up to ${config.MAX_CATCHUP_DAYS}d to catch up from a checkpoint (s3 and traces)`);
    console.log(`  └─ concurrency         ${config.FILE_CONCURRENCY} file(s), ${config.SEND_CONCURRENCY} AKTO request(s) at a time`);
}

/** Wraps a pipeline so its wall-clock cost is visible — the two share one Lambda time budget. */
async function timed(label, fn) {
    const startedAt = Date.now();
    try {
        return await fn();
    } finally {
        console.log(`⏳ ${label} took ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }
}

/** Where the S3 pipeline has read up to: the newest LastModified, and the files read at exactly that second. */
async function checkpoint(discoveredAgents, filesProcessed, position, failedFiles, failedMessages = []) {
    await updateManifest(filesProcessed, discoveredAgents, position.lastTimestamp, failedFiles, failedMessages, position.keysAtTimestamp);
}

/**
 * Sends a batch to AKTO, THEN checkpoints — in that order, so a failed send
 * never advances "last processed" past data that was never actually delivered.
 */
async function flush(messages, discoveredAgents, filesProcessed, position, failedFiles, timeLeft, failedMessages = []) {
    if (messages.length === 0) {
        // Nothing to deliver, but the files were still read — record that.
        console.log(`⏭️ Nothing to send; checkpointing file progress only`);
        await checkpoint(discoveredAgents, filesProcessed, position, failedFiles, failedMessages);
        return 0;
    }
    console.log(`📤 Flushing ${messages.length} message(s) to AKTO Ingestion API...`);
    const { sent, quarantined } = await sendToDataIngestionService(messages, timeLeft);
    // Quarantined messages are resolved, not pending — the server refused them and
    // will refuse them identically next run. Checkpointing past them is what stops
    // the run replaying the messages that DID land alongside them.
    if (quarantined.length > 0) failedMessages.push(...quarantined);
    console.log(`✅ Sent ${sent} message(s) to AKTO${quarantined.length ? `, ${quarantined.length} quarantined` : ''}`);
    await checkpoint(discoveredAgents, filesProcessed, position, failedFiles, failedMessages);
    return sent;
}

/** Same as flush(), but for the AgentCore trace pipeline's manifest shape. */
async function flushTrace(messages, discoveredAgents, logGroupCheckpoints, timeLeft) {
    if (messages.length === 0) return 0;
    await sendToDataIngestionService(messages, timeLeft);
    await updateTraceManifest(discoveredAgents, logGroupCheckpoints);
    return messages.length;
}

/**
 * Turns one AgentCore log group's new log events into AKTO conversation
 * messages — one message per trace, not per record. Records are grouped by
 * traceId first, then identity+content resolved jointly per trace.
 */
async function buildTraceMessagesForLogGroup(events, logGroup, roleNameToResourceMap, harnessNameToResourceMap) {
    // Counted rather than logged per record: a busy log group holds thousands of
    // spans, and the useful question is "where did they all go", not "what was
    // record 4,812". One summary line per log group answers that.
    const stats = { unparseable: 0, other: 0, noTraceId: 0, SPAN: 0, STRANDS_AGGREGATE: 0, GENAI_EVENT: 0, emptyContent: 0, failed: 0 };

    const recordsByTraceId = new Map();
    for (const event of events) {
        const record = parseLogRecord(event);
        if (!record) { stats.unparseable++; continue; }
        const kind = classifyRecord(record);
        if (kind === 'OTHER') { stats.other++; continue; }
        if (!record.traceId) { stats.noTraceId++; continue; }
        stats[kind]++;
        if (!recordsByTraceId.has(record.traceId)) recordsByTraceId.set(record.traceId, []);
        recordsByTraceId.get(record.traceId).push(record);
    }

    const messages = [];
    for (const [traceId, records] of recordsByTraceId) {
        try {
            const content = resolveTraceContent(records);
            if (!content.userMessage && !content.agentResponse) { stats.emptyContent++; continue; }
            const identity = resolveTraceIdentity(records);
            const pair = buildConversationPair(identity, content, logGroup, roleNameToResourceMap, harnessNameToResourceMap, records);
            messages.push(await createTraceStandardMessage(pair));
        } catch (error) {
            stats.failed++;
            console.error(`❌ Error building AgentCore message for trace ${traceId}: ${error.message}`);
        }
    }

    console.log(`🧾 ${logGroup.logGroupName}: ${events.length} event(s) → ${recordsByTraceId.size} trace(s) → ${messages.length} message(s) | ${JSON.stringify(stats)}`);

    // Events arrived but produced nothing — say which stage swallowed them, since
    // otherwise this looks identical to "no traffic at all".
    if (events.length > 0 && messages.length === 0) {
        const reason = stats.emptyContent > 0
            ? `${stats.emptyContent} trace(s) carried no user/agent message — spans present but conversation content missing`
            : recordsByTraceId.size === 0
                ? `no usable records: ${stats.other} unrecognised, ${stats.noTraceId} without a traceId, ${stats.unparseable} unparseable`
                : `${stats.failed} trace(s) failed to build`;
        console.warn(`⚠️ ${logGroup.logGroupName}: no messages produced — ${reason}`);
    }
    return messages;
}

/**
 * Bedrock Agent Classic: S3 model-invocation logs → AKTO.
 *
 * `logLocation` is where this account's logs live, resolved once per run by
 * bedrockDelivery.js. When it carries { skip }, this account has no S3 model invocation
 * logging and there are no files to read — but agent DISCOVERY still runs, because it
 * reads the Bedrock Agent control plane rather than the logs.
 */
async function runS3Pipeline(timeLeft, sendTimeLeft, logLocation) {
    resetLogStats();
    resetRunLogState();
    const manifest = await getManifest();
    const discoveredAgents = { ...(manifest.discoveredAgents || {}) };
    // Advanced file by file, in LastModified order. keysAtTimestamp lists the files read
    // at exactly lastTimestamp, so a file sharing that second is not skipped next run.
    // null = unknown (a manifest from before the list existed): left unwritten until the
    // checkpoint moves to a second whose files this run has seen in full.
    const position = {
        lastTimestamp: manifest.lastProcessedTimestamp || null,
        keysAtTimestamp: Array.isArray(manifest.processedKeysAtCheckpoint) ? [...manifest.processedKeysAtCheckpoint] : null
    };
    let totalSent = 0;
    // Run-scoped: messages AKTO refused permanently. Accumulated across every flush
    // (discovery included) so one manifest write carries them all.
    const failedMessages = [];

    console.log('📋 Rebuilding role map from discovered agents...');
    await rebuildRoleMapFromDiscoveredAgents(discoveredAgents, timeLeft);

    console.log('📋 Discovering agents...');
    const discoveryMessages = await discoverAllNewAgents(discoveredAgents, timeLeft);
    console.log(`✅ Discovery: ${discoveryMessages.length} new resource(s) found`);

    if (discoveryMessages.length > 0) {
        totalSent += await flush(discoveryMessages, discoveredAgents, 0, position, [], sendTimeLeft, failedMessages);
    }

    const logsBucket = logLocation?.bucket || config.LOGS_BUCKET_NAME;
    const logsPrefix = logLocation?.prefix || config.LOGS_PREFIX;
    const cursor = logLocation?.skip
        ? NO_LOG_FILES
        : await openLogFileCursor(manifest, timeLeft, { bucket: logsBucket, prefix: logsPrefix });

    let pending = [];
    let filesDone = 0;
    let filesFailed = 0;
    let filesDeferred = 0;
    const failedFiles = [];

    const advance = (file) => {
        const fileTs = new Date(file.LastModified).toISOString();
        if (!position.lastTimestamp || fileTs > position.lastTimestamp) {
            position.lastTimestamp = fileTs;
            position.keysAtTimestamp = [file.Key];
        } else if (fileTs === position.lastTimestamp && position.keysAtTimestamp) {
            position.keysAtTimestamp.push(file.Key);
        }
    };

    let batch;
    batches: while ((batch = await cursor.next()) !== null) {
        // Files are fetched FILE_CONCURRENCY at a time but applied strictly in order, so
        // the checkpoint only ever moves past files whose outcome is known.
        for (let i = 0; i < batch.length; i += config.FILE_CONCURRENCY) {
            if (timeLeft() < config.TIME_SAFETY_MARGIN_MS) {
                filesDeferred = batch.length - i + cursor.buffered();
                console.warn(`⏱️ ${timeLeft()}ms left (below ${config.TIME_SAFETY_MARGIN_MS}ms margin) — stopping early, ${filesDeferred} listed file(s) deferred to next run`);
                break batches;
            }

            const group = batch.slice(i, i + config.FILE_CONCURRENCY);
            const results = await Promise.allSettled(group.map((file) => processLogFile(logsBucket, file.Key, discoveredAgents)));
            results.forEach((result, j) => {
                const file = group[j];
                if (result.status === 'fulfilled') {
                    pending.push(...result.value);
                    filesDone++;
                } else {
                    // Progress moves past a failed file rather than stalling on it, so one
                    // unreadable object can never block the whole backlog. The cost is that
                    // this file is not retried — hence the loud log AND a durable record in
                    // the manifest, so it stays visible after the logs age out.
                    filesFailed++;
                    failedFiles.push({ key: file.Key, error: result.reason.message, at: new Date().toISOString() });
                    console.error(`❌ File FAILED and will NOT be retried: ${file.Key} — ${result.reason.message} (recorded in manifest.failedFiles)`);
                }
                // Advances on success and failure alike: the checkpoint means "read this
                // far", and files are processed oldest-first.
                advance(file);
            });

            if (pending.length >= config.FLUSH_THRESHOLD || timeLeft() < config.TIME_SAFETY_MARGIN_MS) {
                totalSent += await flush(pending, discoveredAgents, filesDone, position, failedFiles, sendTimeLeft, failedMessages);
                pending = [];
                logMemory(`checkpoint (${filesDone} files)`);
            }
        }
    }
    // Listing stopped by the clock before reaching now: there is more to read even if
    // nothing listed is waiting.
    const moreToList = !cursor.complete;
    if (filesDeferred === 0) filesDeferred = cursor.buffered();

    // Checkpoint on every path that read at least one file — including the case
    // where nothing was extracted, which is what used to lose all progress.
    if (pending.length > 0 || filesDone > 0 || filesFailed > 0) {
        totalSent += await flush(pending, discoveredAgents, filesDone, position, failedFiles, sendTimeLeft, failedMessages);
    }
    if (filesDone === 0 && filesFailed === 0 && discoveryMessages.length === 0 && !moreToList) {
        console.log('✅ Bedrock Agent Classic: nothing new to process');
    }

    const stats = { ...getLogStats(), ...getIdentityStats() };
    console.log(`🎉 Bedrock Agent Classic done. Files processed: ${filesDone}, failed: ${filesFailed}, deferred: ${filesDeferred}${moreToList ? ' (+ folders not yet listed)' : ''}, messages sent: ${totalSent}, checkpoint: ${position.lastTimestamp || 'unchanged'}`);
    console.log(`📇 Traffic seen: ${stats.agentCalls} agent call(s) ingested, ${stats.serviceAgentIngested} direct model call(s) ingested, ${stats.serviceAgentCalls} dropped, ${stats.noConversation} entr(ies) with no complete exchange, ${stats.noIdentity} without a usable identity, ${stats.unparseableLines} unparseable line(s)`);
    console.log(`🔗 Identity resolved: ${stats.resolvedByRole} by execution role, ${stats.resolvedBySession} by session name (shared role), ${stats.serviceAgentCallers} as direct-model callers, ${stats.ambiguousSkips} skipped as ambiguous, ${stats.noPrincipal} with an unrecognised ARN`);
    if (failedMessages.length > 0) {
        console.warn(`🚫 ${failedMessages.length} message(s) were permanently rejected by AKTO and are recorded in manifest.failedMessages — they are NOT retried. requestId(s): ${failedMessages.slice(0, 5).map((m) => m.requestId).join(', ')}${failedMessages.length > 5 ? ', …' : ''}`);
    }
    if (filesFailed > 0) {
        console.warn(`⚠️ ${filesFailed} file(s) were skipped permanently and are listed in manifest.failedFiles — inspect them if data looks missing`);
    }
    return { filesDone, filesFailed, filesDeferred, moreToList, totalSent, messagesQuarantined: failedMessages.length, traffic: stats };
}

/** The cursor for an account whose logs are not in S3: nothing to read, nothing pending. */
const NO_LOG_FILES = { complete: true, buffered: () => 0, next: async () => null };

/** Whether the S3 pipeline stopped with work still waiting — listed files, or folders not yet listed. */
const s3HasBacklog = (result) => result.filesDeferred > 0 || result.moreToList;

/** AgentCore Harness/Runtime: CloudWatch traces → AKTO. Own manifest, own discovery, own time-budget checks. */
async function runAgentCorePipeline(timeLeft, sendTimeLeft) {
    if (!traceHarnessInitialized) {
        await initializeTraceHarnessCache();
        traceHarnessInitialized = true;
    }

    const traceManifest = await getTraceManifest();
    const discoveredAgents = { ...(traceManifest.discoveredAgents || {}) };
    const logGroupCheckpoints = { ...(traceManifest.logGroupCheckpoints || {}) };
    let totalSent = 0;

    console.log('📋 Discovering AgentCore harnesses/runtimes...');
    const discoveryMessages = await discoverNewResources(discoveredAgents, timeLeft);
    console.log(`✅ AgentCore discovery: ${discoveryMessages.length} new resource(s) found`);
    if (discoveryMessages.length > 0) {
        totalSent += await flushTrace(discoveryMessages, discoveredAgents, logGroupCheckpoints, sendTimeLeft);
    }

    await backfillExecutionRoleArns(discoveredAgents, timeLeft);
    const roleNameToResourceMap = buildRoleNameToResourceMap(discoveredAgents);
    const harnessNameToResourceMap = buildHarnessNameToResourceMap(discoveredAgents);

    const logGroups = await discoverObservabilityLogGroups();
    let groupsProcessed = 0;
    let groupsDeferred = 0;

    if (logGroups.length === 0) {
        console.log('✅ No AgentCore observability log groups found — tracing likely not enabled on this account. Discovery still ran above.');
        return { logGroupsFound: 0, groupsProcessed, groupsDeferred, totalSent };
    }

    const DAY_MS = 24 * 60 * 60 * 1000;
    const lookbackMs = Date.now() - config.TRACE_LOOKBACK_DAYS * DAY_MS;
    const catchupFloorMs = Date.now() - config.MAX_CATCHUP_DAYS * DAY_MS;

    for (const logGroup of logGroups) {
        if (timeLeft() < config.TIME_SAFETY_MARGIN_MS) {
            groupsDeferred = logGroups.length - groupsProcessed;
            console.warn(`⏱️ ${timeLeft()}ms left — stopping early, ${groupsDeferred} AgentCore log group(s) deferred to next run`);
            break;
        }

        const stored = logGroupCheckpoints[logGroup.logGroupName]?.lastEventTimestamp;
        if (stored && stored < catchupFloorMs) {
            console.warn(`⚠️ ${logGroup.logGroupName}: checkpoint ${new Date(stored).toISOString()} is older than ${config.MAX_CATCHUP_DAYS} days — resuming from ${new Date(catchupFloorMs).toISOString()}`);
        }
        const sinceMs = stored ? Math.max(stored, catchupFloorMs) : lookbackMs;

        // Each chunk becomes messages, is sent, and is checkpointed before the next is
        // read, so memory holds one chunk and a stop mid-group keeps what was done.
        await readNewLogEventsInChunks(logGroup.logGroupName, sinceMs, {
            timeLeft,
            timeSafetyMarginMs: config.TIME_SAFETY_MARGIN_MS,
            chunkSize: config.TRACE_CHUNK_EVENTS,
            onChunk: async (events, checkpointMs) => {
                // buildTraceMessagesForLogGroup already logs the full event → trace → message
                // accounting for this chunk, so there's nothing to restate here.
                const messages = await buildTraceMessagesForLogGroup(events, logGroup, roleNameToResourceMap, harnessNameToResourceMap);
                logGroupCheckpoints[logGroup.logGroupName] = { lastEventTimestamp: checkpointMs, runtimeId: logGroup.runtimeId };
                if (messages.length > 0) {
                    totalSent += await flushTrace(messages, discoveredAgents, logGroupCheckpoints, sendTimeLeft);
                } else {
                    // No messages built, but there's no unsent data at risk — checkpoint now
                    // so this log group doesn't re-scan the same events every run.
                    await updateTraceManifest(discoveredAgents, logGroupCheckpoints);
                }
            }
        });
        groupsProcessed++;
    }

    console.log(`🎉 AgentCore done. Log groups processed: ${groupsProcessed}, deferred: ${groupsDeferred}, messages sent: ${totalSent}`);
    return { logGroupsFound: logGroups.length, groupsProcessed, groupsDeferred, totalSent };
}

/**
 * Main handler.
 *
 * The S3 pipeline runs first, holding at most its half of the run budget before it
 * has to hand over; AgentCore then gets everything that is left. The split is a floor
 * for AgentCore rather than a ceiling on S3 — time one pipeline doesn't use passes to
 * the other, so neither is throttled when the other has nothing to do. The
 * per-pipeline `⏳ … took Ns` timings show how the budget actually split, so
 * starvation is visible rather than inferred.
 */
exports.handler = async (event, context) => {
    console.log(`🚀 AKTO Bedrock Log Processor started — build ${config.CODE_VERSION}`);
    console.log(`📍 Region: ${config.AWS_REGION} | Event: ${event?.source || 'manual'} | Time budget: ${context.getRemainingTimeInMillis()}ms`);
    logMemory('start');

    const lambdaTimeLeft = () => context.getRemainingTimeInMillis();
    const startedAt = Date.now();

    /**
     * The time every worker loop actually sees: whichever runs out first — the
     * Lambda clock, or this run's wall-clock budget.
     *
     * Expressed as a shrinking timeLeft() rather than a separate flag so that
     * every existing guard (`timeLeft() < TIME_SAFETY_MARGIN_MS`), including the
     * ones inside discovery.js and traceDiscovery.js, respects the budget without
     * being modified. When the budget is spent this reports exactly the safety
     * margin, which those guards already treat as "stop taking new work".
     */
    const timeLeft = () => {
        const budgetRemaining = config.RUN_BUDGET_MS - (Date.now() - startedAt);
        // Once the budget is gone this reports 0, not the margin — the guards test
        // `< TIME_SAFETY_MARGIN_MS`, so returning exactly the margin would compare
        // false and the budget would never actually stop anything.
        return Math.min(lambdaTimeLeft(), budgetRemaining > 0 ? config.TIME_SAFETY_MARGIN_MS + budgetRemaining : 0);
    };
    const stoppedByBudget = () => config.RUN_BUDGET_MS - (Date.now() - startedAt) <= 0;

    /*
     * Delivering messages already in hand is a different question from taking on more
     * work, and it needs a different clock.
     *
     * Sending is bounded (the messages are already collected) and short — seconds for
     * a full batch — so it is gated on the Lambda clock, which still has the remainder
     * of the timeout. A run may therefore overshoot RUN_BUDGET_MS by the flush
     * duration; that is a deliberate trade against discarding work already paid for,
     * and the schedule keeps ~2 minutes of headroom for it.
     */
    const sendTimeLeft = () => lambdaTimeLeft();

    /**
     * The same shrinking clock, additionally capped at a share of the run budget.
     * Used to hand S3 half the run before AgentCore starts; expressed in the same
     * form so the existing `< TIME_SAFETY_MARGIN_MS` guards need no changes.
     */
    const sliceTimeLeft = (sliceMs) => () => {
        const sliceRemaining = sliceMs - (Date.now() - startedAt);
        return Math.min(timeLeft(), sliceRemaining > 0 ? config.TIME_SAFETY_MARGIN_MS + sliceRemaining : 0);
    };

    let runLock = null;
    try {
        config.validateConfig();

        // One run at a time: a scheduled run that overlaps one still in progress, or a
        // Lambda retry of a run that already happened, exits here without touching data.
        runLock = await acquireRunLock(context.awsRequestId || `local-${startedAt}`, lambdaTimeLeft());
        if (!runLock.acquired) {
            console.warn(`⏭️ Skipping this run — ${runLock.reason}`);
            return { statusCode: 200, body: JSON.stringify({ codeVersion: config.CODE_VERSION, skipped: runLock.reason }) };
        }

        logEffectiveConfig();
        console.log(`  └─ run budget          ${(config.RUN_BUDGET_MS / 1000).toFixed(0)}s of work (schedule is ${(config.SCHEDULE_INTERVAL_MS / 60000).toFixed(0)}min; finishing inside it keeps runs from overlapping)`);
        console.log(`  └─ budget split        S3 holds up to ${(config.S3_BUDGET_MS / 1000).toFixed(0)}s (${Math.round(config.S3_BUDGET_SHARE * 100)}%), AgentCore gets the rest plus anything S3 leaves`);

        /*
         * Resolved once, before either pipeline, and reused by the second pass: the
         * lookup costs an API call and, in 'create' mode, can provision a bucket.
         *
         * A skip is a normal outcome across a fleet, not a failure: the account keeps its
         * agent discovery and its AgentCore traces, and only conversation capture from S3
         * is unavailable.
         */
        const logLocation = await resolveBedrockLogLocation();
        if (logLocation.skip) {
            console.warn(`⚠️ Skipping S3 log processing for account ${config.AWS_ACCOUNT_ID} (${config.AWS_REGION}): ${logLocation.reason}`);
        } else if (logLocation.justCreated) {
            console.log('ℹ️ Logging was just enabled — this run finds no files yet; the next scheduled run picks up what Bedrock writes in the meantime');
        }

        const bedrockAgentClassic = await timed('Bedrock Agent Classic pipeline', () => runS3Pipeline(sliceTimeLeft(config.S3_BUDGET_MS), sendTimeLeft, logLocation));
        logMemory('after S3 pipeline');

        // Whatever S3 didn't use rolls over rather than being forfeited, so a run with
        // no S3 backlog spends the full budget on traces.
        const handoverAt = Date.now() - startedAt;
        console.log(`🔀 S3 handed over after ${(handoverAt / 1000).toFixed(0)}s of its ${(config.S3_BUDGET_MS / 1000).toFixed(0)}s share — AgentCore now has ${(Math.max(0, config.RUN_BUDGET_MS - handoverAt) / 1000).toFixed(0)}s`);

        const agentCore = await timed('AgentCore pipeline', () => runAgentCorePipeline(timeLeft, sendTimeLeft));
        logMemory('after AgentCore pipeline');

        /*
         * Give the rest of the budget back to S3 if it still has a backlog.
         *
         * The share is a floor for AgentCore, not a ceiling on S3, and without this
         * the floor becomes a ceiling in one common case: an account with only
         * Bedrock Agent Classic data. AgentCore finds no log groups and returns in
         * milliseconds, so S3 would stop at half the budget and leave the other half
         * unspent with files still waiting. This resumes from the checkpoint the
         * first pass just wrote, so no file is read twice.
         */
        let s3SecondPass = null;
        if (s3HasBacklog(bedrockAgentClassic) && timeLeft() > config.TIME_SAFETY_MARGIN_MS) {
            console.log(`♻️ AgentCore finished with ${(timeLeft() / 1000).toFixed(0)}s left and S3 has ${bedrockAgentClassic.filesDeferred} file(s) deferred — returning the remaining budget to S3`);
            s3SecondPass = await timed('Bedrock Agent Classic pipeline (second pass)', () => runS3Pipeline(timeLeft, sendTimeLeft, logLocation));
            // One combined view: totals add up, and "deferred" is whatever the second
            // pass ended with, since it superseded the first pass's remainder.
            bedrockAgentClassic.filesDone += s3SecondPass.filesDone;
            bedrockAgentClassic.filesFailed += s3SecondPass.filesFailed;
            bedrockAgentClassic.totalSent += s3SecondPass.totalSent;
            bedrockAgentClassic.filesDeferred = s3SecondPass.filesDeferred;
            bedrockAgentClassic.moreToList = s3SecondPass.moreToList;
            // runS3Pipeline resets the traffic counters on entry, so the second pass's
            // stats cover only its own files. Sum them, or the run summary would report
            // whichever pass happened to finish last and undercount the other.
            for (const [key, value] of Object.entries(s3SecondPass.traffic || {})) {
                bedrockAgentClassic.traffic[key] = (bedrockAgentClassic.traffic[key] || 0) + value;
            }
            bedrockAgentClassic.secondPass = { filesDone: s3SecondPass.filesDone, totalSent: s3SecondPass.totalSent };
            console.log(`♻️ Second pass added ${s3SecondPass.filesDone} file(s) and ${s3SecondPass.totalSent} message(s) — ${bedrockAgentClassic.filesDeferred} still deferred`);
        }
        logMemory('end');

        // One structured line per run, so CloudWatch Insights can chart throughput
        // and spot deferrals without parsing prose:
        //   fields @timestamp, @message | filter @message like /RUN SUMMARY/
        const summary = {
            codeVersion: config.CODE_VERSION,
            durationMs: Date.now() - startedAt,
            runBudgetMs: config.RUN_BUDGET_MS,
            s3BudgetMs: config.S3_BUDGET_MS,
            s3HandoverMs: handoverAt,
            pipelineOrder: 's3-then-agentcore',
            // Which limit ended the run — the schedule-derived budget (expected on a
            // backlog) or the Lambda clock (means the budget is set too high).
            // 'work-complete' is reserved for runs that deferred nothing: with the
            // second S3 pass returning leftover time, anything still deferred means
            // the budget genuinely ran out rather than a share getting in the way.
            stoppedBy: stoppedByBudget()
                ? 'run-budget'
                : lambdaTimeLeft() < config.TIME_SAFETY_MARGIN_MS
                    ? 'lambda-timeout'
                    : (s3HasBacklog(bedrockAgentClassic) || agentCore.groupsDeferred > 0) ? 'deferred-work-remaining' : 'work-complete',
            lambdaTimeLeftMs: lambdaTimeLeft(),
            messagesSent: bedrockAgentClassic.totalSent + agentCore.totalSent,
            s3: bedrockAgentClassic,
            agentCore
        };
        console.log(`📊 RUN SUMMARY ${JSON.stringify(summary)}`);
        if (s3HasBacklog(bedrockAgentClassic) || agentCore.groupsDeferred > 0) {
            console.warn(`⏱️ Work was deferred to the next run (${bedrockAgentClassic.filesDeferred} file(s), ${agentCore.groupsDeferred} log group(s)) — expected while catching up on a backlog, but persistent deferrals mean the schedule can't keep pace`);
        }

        // The summary goes in the response too, not just the log — `aws lambda invoke`
        // then shows why a run stopped without having to open CloudWatch.
        return { statusCode: 200, body: JSON.stringify(summary) };

    } catch (error) {
        console.error(`❌ Handler failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${error.message}`);
        console.error(error.stack);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    } finally {
        if (runLock?.acquired) await runLock.release();
    }
};
