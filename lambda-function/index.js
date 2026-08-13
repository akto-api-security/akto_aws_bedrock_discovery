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
const { getUnprocessedLogFiles, processLogFile, resetLogStats, getLogStats } = require('./s3Logs');
const { discoverAllNewAgents, rebuildRoleMapFromDiscoveredAgents, resetRunLogState, getIdentityStats } = require('./discovery');
const { sendToDataIngestionService } = require('./aktoClient');

const {
    discoverNewResources, initializeHarnessCache: initializeTraceHarnessCache, backfillExecutionRoleArns,
    buildRoleNameToResourceMap, buildHarnessNameToResourceMap, createStandardMessage: createTraceStandardMessage
} = require('./traceDiscovery');
const { discoverObservabilityLogGroups, fetchNewLogEvents } = require('./logGroupReader');
const { classifyRecord, parseLogRecord, resolveTraceIdentity, resolveTraceContent, buildConversationPair } = require('./traceParser');
const { getTraceManifest, updateTraceManifest } = require('./traceManifest');

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

    console.log('⚙️ Effective configuration:');
    console.log(`  ├─ region              ${config.AWS_REGION} (account ${config.AWS_ACCOUNT_ID})`);
    console.log(`  ├─ bedrock logs        s3://${config.LOGS_BUCKET_NAME}/${config.LOGS_PREFIX}`);
    console.log(`  ├─ checkpoints         s3://${config.MARKERS_BUCKET_NAME}/${config.MARKERS_PREFIX}`);
    console.log(`  ├─ agentcore logs      ${config.RUNTIME_LOG_GROUP_PREFIX}*`);
    console.log(`  ├─ akto ingest host    ${ingestHost} (api key ${config.AKTO_API_KEY ? 'set' : 'MISSING'})`);
    console.log(`  └─ lookback            ${config.LOOKBACK_DAYS}d s3 / ${config.TRACE_LOOKBACK_DAYS}d traces`);
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

async function checkpoint(discoveredAgents, filesProcessed, lastTimestamp, failedFiles) {
    await updateManifest(filesProcessed, discoveredAgents, lastTimestamp, failedFiles);
}

/**
 * Sends a batch to AKTO, THEN checkpoints — in that order, so a failed send
 * never advances "last processed" past data that was never actually delivered.
 */
async function flush(messages, discoveredAgents, filesProcessed, lastTimestamp, failedFiles, timeLeft) {
    if (messages.length === 0) {
        // Nothing to deliver, but the files were still read — record that.
        console.log(`⏭️ Nothing to send; checkpointing file progress only`);
        await checkpoint(discoveredAgents, filesProcessed, lastTimestamp, failedFiles);
        return 0;
    }
    console.log(`📤 Flushing ${messages.length} message(s) to AKTO Ingestion API...`);
    await sendToDataIngestionService(messages, timeLeft);
    console.log(`✅ Successfully sent ${messages.length} message(s) to AKTO`);
    await checkpoint(discoveredAgents, filesProcessed, lastTimestamp, failedFiles);
    return messages.length;
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

/** Bedrock Agent Classic: S3 model-invocation logs → AKTO. Unchanged from before the AgentCore merge. */
async function runS3Pipeline(timeLeft) {
    resetLogStats();
    resetRunLogState();
    const manifest = await getManifest();
    const discoveredAgents = { ...(manifest.discoveredAgents || {}) };
    let lastTimestamp = manifest.lastProcessedTimestamp || null;
    let totalSent = 0;

    console.log('📋 Rebuilding role map from discovered agents...');
    await rebuildRoleMapFromDiscoveredAgents(discoveredAgents, timeLeft);

    console.log('📋 Discovering agents...');
    const discoveryMessages = await discoverAllNewAgents(discoveredAgents, timeLeft);
    console.log(`✅ Discovery: ${discoveryMessages.length} new resource(s) found`);

    if (discoveryMessages.length > 0) {
        totalSent += await flush(discoveryMessages, discoveredAgents, 0, lastTimestamp, [], timeLeft);
    }

    const unprocessedFiles = await getUnprocessedLogFiles(manifest);
    console.log(`📁 ${unprocessedFiles.length} unprocessed log file(s)`);

    let pending = [];
    let filesDone = 0;
    let filesFailed = 0;
    let filesDeferred = 0;
    const failedFiles = [];

    for (const file of unprocessedFiles) {
        if (timeLeft() < config.TIME_SAFETY_MARGIN_MS) {
            filesDeferred = unprocessedFiles.length - filesDone - filesFailed;
            console.warn(`⏱️ ${timeLeft()}ms left (below ${config.TIME_SAFETY_MARGIN_MS}ms margin) — stopping early, ${filesDeferred} file(s) deferred to next run`);
            break;
        }

        const fileTs = new Date(file.LastModified).toISOString();
        try {
            const messages = await processLogFile(config.LOGS_BUCKET_NAME, file.Key, discoveredAgents);
            pending.push(...messages);
            filesDone++;
        } catch (error) {
            // Progress moves past a failed file rather than stalling on it, so one
            // unreadable object can never block the whole backlog. The cost is that
            // this file is not retried — hence the loud log AND a durable record in
            // the manifest, so it stays visible after the logs age out.
            filesFailed++;
            failedFiles.push({ key: file.Key, error: error.message, at: new Date().toISOString() });
            console.error(`❌ File FAILED and will NOT be retried: ${file.Key} — ${error.message} (recorded in manifest.failedFiles)`);
        }
        // Advances on success and failure alike: the checkpoint means "read this
        // far", and files are processed oldest-first.
        if (!lastTimestamp || fileTs > lastTimestamp) lastTimestamp = fileTs;

        if (pending.length >= config.FLUSH_THRESHOLD || timeLeft() < config.TIME_SAFETY_MARGIN_MS) {
            totalSent += await flush(pending, discoveredAgents, filesDone, lastTimestamp, failedFiles, timeLeft);
            pending = [];
            logMemory(`checkpoint (${filesDone}/${unprocessedFiles.length} files)`);
        }
    }

    // Checkpoint on every path that read at least one file — including the case
    // where nothing was extracted, which is what used to lose all progress.
    if (pending.length > 0 || filesDone > 0 || filesFailed > 0) {
        totalSent += await flush(pending, discoveredAgents, filesDone, lastTimestamp, failedFiles, timeLeft);
    }
    if (filesDone === 0 && filesFailed === 0 && discoveryMessages.length === 0) {
        console.log('✅ Bedrock Agent Classic: nothing new to process');
    }

    const stats = { ...getLogStats(), ...getIdentityStats() };
    console.log(`🎉 Bedrock Agent Classic done. Files processed: ${filesDone}, failed: ${filesFailed}, deferred: ${filesDeferred}, messages sent: ${totalSent}, checkpoint: ${lastTimestamp || 'unchanged'}`);
    console.log(`📇 Traffic seen: ${stats.agentCalls} agent call(s) ingested, ${stats.serviceAgentIngested} direct model call(s) ingested, ${stats.serviceAgentCalls} dropped, ${stats.noConversation} entr(ies) with no complete exchange, ${stats.noIdentity} without a usable identity, ${stats.unparseableLines} unparseable line(s)`);
    console.log(`🔗 Identity resolved: ${stats.resolvedByRole} by execution role, ${stats.resolvedBySession} by session name (shared role), ${stats.serviceAgentCallers} as direct-model callers, ${stats.ambiguousSkips} skipped as ambiguous, ${stats.noPrincipal} with an unrecognised ARN`);
    if (filesFailed > 0) {
        console.warn(`⚠️ ${filesFailed} file(s) were skipped permanently and are listed in manifest.failedFiles — inspect them if data looks missing`);
    }
    return { filesDone, filesFailed, filesDeferred, totalSent, traffic: stats };
}

/** AgentCore Harness/Runtime: CloudWatch traces → AKTO. Own manifest, own discovery, own time-budget checks. */
async function runAgentCorePipeline(timeLeft) {
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
        totalSent += await flushTrace(discoveryMessages, discoveredAgents, logGroupCheckpoints, timeLeft);
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

    const lookbackMs = Date.now() - config.TRACE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

    for (const logGroup of logGroups) {
        if (timeLeft() < config.TIME_SAFETY_MARGIN_MS) {
            groupsDeferred = logGroups.length - groupsProcessed;
            console.warn(`⏱️ ${timeLeft()}ms left — stopping early, ${groupsDeferred} AgentCore log group(s) deferred to next run`);
            break;
        }

        const sinceMs = logGroupCheckpoints[logGroup.logGroupName]?.lastEventTimestamp || lookbackMs;
        const { events, latestTimestamp } = await fetchNewLogEvents(logGroup.logGroupName, sinceMs, timeLeft, config.TIME_SAFETY_MARGIN_MS);
        groupsProcessed++;

        if (events.length === 0) continue;

        // buildTraceMessagesForLogGroup already logs the full event → trace → message
        // accounting for this group, so there's nothing to restate here.
        const messages = await buildTraceMessagesForLogGroup(events, logGroup, roleNameToResourceMap, harnessNameToResourceMap);
        logGroupCheckpoints[logGroup.logGroupName] = { lastEventTimestamp: latestTimestamp, runtimeId: logGroup.runtimeId };

        if (messages.length > 0) {
            totalSent += await flushTrace(messages, discoveredAgents, logGroupCheckpoints, timeLeft);
        } else {
            // No messages built, but there's no unsent data at risk — checkpoint now
            // so this log group doesn't re-scan the same events every run.
            await updateTraceManifest(discoveredAgents, logGroupCheckpoints);
        }
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
    console.log('🚀 AKTO Bedrock Log Processor started');
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

    /**
     * The same shrinking clock, additionally capped at a share of the run budget.
     * Used to hand S3 half the run before AgentCore starts; expressed in the same
     * form so the existing `< TIME_SAFETY_MARGIN_MS` guards need no changes.
     */
    const sliceTimeLeft = (sliceMs) => () => {
        const sliceRemaining = sliceMs - (Date.now() - startedAt);
        return Math.min(timeLeft(), sliceRemaining > 0 ? config.TIME_SAFETY_MARGIN_MS + sliceRemaining : 0);
    };

    try {
        config.validateConfig();
        logEffectiveConfig();
        console.log(`  └─ run budget          ${(config.RUN_BUDGET_MS / 1000).toFixed(0)}s of work (schedule is ${(config.SCHEDULE_INTERVAL_MS / 60000).toFixed(0)}min; finishing inside it keeps runs from overlapping)`);
        console.log(`  └─ budget split        S3 holds up to ${(config.S3_BUDGET_MS / 1000).toFixed(0)}s (${Math.round(config.S3_BUDGET_SHARE * 100)}%), AgentCore gets the rest plus anything S3 leaves`);

        const bedrockAgentClassic = await timed('Bedrock Agent Classic pipeline', () => runS3Pipeline(sliceTimeLeft(config.S3_BUDGET_MS)));
        logMemory('after S3 pipeline');

        // Whatever S3 didn't use rolls over rather than being forfeited, so a run with
        // no S3 backlog spends the full budget on traces.
        const handoverAt = Date.now() - startedAt;
        console.log(`🔀 S3 handed over after ${(handoverAt / 1000).toFixed(0)}s of its ${(config.S3_BUDGET_MS / 1000).toFixed(0)}s share — AgentCore now has ${(Math.max(0, config.RUN_BUDGET_MS - handoverAt) / 1000).toFixed(0)}s`);

        const agentCore = await timed('AgentCore pipeline', () => runAgentCorePipeline(timeLeft));
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
        if (bedrockAgentClassic.filesDeferred > 0 && timeLeft() > config.TIME_SAFETY_MARGIN_MS) {
            console.log(`♻️ AgentCore finished with ${(timeLeft() / 1000).toFixed(0)}s left and S3 has ${bedrockAgentClassic.filesDeferred} file(s) deferred — returning the remaining budget to S3`);
            s3SecondPass = await timed('Bedrock Agent Classic pipeline (second pass)', () => runS3Pipeline(timeLeft));
            // One combined view: totals add up, and "deferred" is whatever the second
            // pass ended with, since it superseded the first pass's remainder.
            bedrockAgentClassic.filesDone += s3SecondPass.filesDone;
            bedrockAgentClassic.filesFailed += s3SecondPass.filesFailed;
            bedrockAgentClassic.totalSent += s3SecondPass.totalSent;
            bedrockAgentClassic.filesDeferred = s3SecondPass.filesDeferred;
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
                    : (bedrockAgentClassic.filesDeferred > 0 || agentCore.groupsDeferred > 0) ? 'deferred-work-remaining' : 'work-complete',
            lambdaTimeLeftMs: lambdaTimeLeft(),
            messagesSent: bedrockAgentClassic.totalSent + agentCore.totalSent,
            s3: bedrockAgentClassic,
            agentCore
        };
        console.log(`📊 RUN SUMMARY ${JSON.stringify(summary)}`);
        if (bedrockAgentClassic.filesDeferred > 0 || agentCore.groupsDeferred > 0) {
            console.warn(`⏱️ Work was deferred to the next run (${bedrockAgentClassic.filesDeferred} file(s), ${agentCore.groupsDeferred} log group(s)) — expected while catching up on a backlog, but persistent deferrals mean the schedule can't keep pace`);
        }

        // The summary goes in the response too, not just the log — `aws lambda invoke`
        // then shows why a run stopped without having to open CloudWatch.
        return { statusCode: 200, body: JSON.stringify(summary) };

    } catch (error) {
        console.error(`❌ Handler failed after ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${error.message}`);
        console.error(error.stack);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
