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
const { getUnprocessedLogFiles, processLogFile } = require('./s3Logs');
const { discoverAllNewAgents, rebuildRoleMapFromDiscoveredAgents } = require('./discovery');
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
 * Sends a batch to AKTO, THEN checkpoints the manifest — in that order, so a
 * failed send never advances "last processed" past data that was never
 * actually delivered.
 */
async function flush(messages, discoveredAgents, filesProcessed, lastTimestamp) {
    if (messages.length === 0) {
        console.log(`⏭️ Skipping flush: 0 messages to send`);
        return 0;
    }
    console.log(`📤 Flushing ${messages.length} message(s) to AKTO Ingestion API...`);
    await sendToDataIngestionService(messages);
    console.log(`✅ Successfully sent ${messages.length} message(s) to AKTO`);
    await updateManifest(filesProcessed, discoveredAgents, lastTimestamp);
    return messages.length;
}

/** Same as flush(), but for the AgentCore trace pipeline's manifest shape. */
async function flushTrace(messages, discoveredAgents, logGroupCheckpoints) {
    if (messages.length === 0) return 0;
    await sendToDataIngestionService(messages);
    await updateTraceManifest(discoveredAgents, logGroupCheckpoints);
    return messages.length;
}

/**
 * Turns one AgentCore log group's new log events into AKTO conversation
 * messages — one message per trace, not per record. Records are grouped by
 * traceId first, then identity+content resolved jointly per trace.
 */
async function buildTraceMessagesForLogGroup(events, logGroup, roleNameToResourceMap, harnessNameToResourceMap) {
    const recordsByTraceId = new Map();
    for (const event of events) {
        const record = parseLogRecord(event);
        if (!record || classifyRecord(record) === 'OTHER' || !record.traceId) continue;
        if (!recordsByTraceId.has(record.traceId)) recordsByTraceId.set(record.traceId, []);
        recordsByTraceId.get(record.traceId).push(record);
    }

    const messages = [];
    for (const [traceId, records] of recordsByTraceId) {
        try {
            const content = resolveTraceContent(records);
            if (!content.userMessage && !content.agentResponse) continue;
            const identity = resolveTraceIdentity(records);
            const pair = buildConversationPair(identity, content, logGroup, roleNameToResourceMap, harnessNameToResourceMap, records);
            messages.push(await createTraceStandardMessage(pair));
        } catch (error) {
            console.error(`❌ Error building AgentCore message for trace ${traceId}: ${error.message}`);
        }
    }
    return messages;
}

/** Bedrock Agent Classic: S3 model-invocation logs → AKTO. Unchanged from before the AgentCore merge. */
async function runS3Pipeline(timeLeft) {
    const manifest = await getManifest();
    const discoveredAgents = { ...(manifest.discoveredAgents || {}) };
    let lastTimestamp = manifest.lastProcessedTimestamp || null;
    let totalSent = 0;

    console.log('📋 Rebuilding role map from discovered agents...');
    await rebuildRoleMapFromDiscoveredAgents(discoveredAgents, timeLeft);

    console.log('📋 Discovering agents...');
    const discoveryMessages = await discoverAllNewAgents(discoveredAgents, timeLeft);
    console.log(`✅ Discovery: ${discoveryMessages.length} new resource(s) found`);

    // Flush discovery on its own, immediately — don't let it ride behind log-file
    // processing in the same batch. Discovery is independent of logs (it only
    // needs Bedrock's ListAgents API).
    if (discoveryMessages.length > 0) {
        totalSent += await flush(discoveryMessages, discoveredAgents, 0, lastTimestamp);
    }

    const unprocessedFiles = await getUnprocessedLogFiles(manifest);
    console.log(`📁 ${unprocessedFiles.length} unprocessed log file(s)`);

    let pending = [];
    let filesDone = 0;
    let filesDeferred = 0;

    for (const file of unprocessedFiles) {
        if (timeLeft() < config.TIME_SAFETY_MARGIN_MS) {
            filesDeferred = unprocessedFiles.length - filesDone;
            console.warn(`⏱️ ${timeLeft()}ms left (below ${config.TIME_SAFETY_MARGIN_MS}ms margin) — stopping early, ${filesDeferred} file(s) deferred to next run`);
            break;
        }

        try {
            const messages = await processLogFile(config.LOGS_BUCKET_NAME, file.Key);
            pending.push(...messages);
            filesDone++;
            const fileTs = new Date(file.LastModified).toISOString();
            if (!lastTimestamp || fileTs > lastTimestamp) lastTimestamp = fileTs;
        } catch (error) {
            console.error(`❌ File failed, skipping: ${file.Key} — ${error.message}`);
        }

        if (pending.length >= config.FLUSH_THRESHOLD || timeLeft() < config.TIME_SAFETY_MARGIN_MS) {
            totalSent += await flush(pending, discoveredAgents, filesDone, lastTimestamp);
            pending = [];
            logMemory(`checkpoint (${filesDone}/${unprocessedFiles.length} files)`);
        }
    }

    if (pending.length > 0) {
        totalSent += await flush(pending, discoveredAgents, filesDone, lastTimestamp);
    } else if (filesDone === 0 && discoveryMessages.length === 0) {
        console.log('✅ Bedrock Agent Classic: nothing new to process');
    }

    console.log(`🎉 Bedrock Agent Classic done. Files processed: ${filesDone}, deferred: ${filesDeferred}, messages sent: ${totalSent}`);
    return { filesDone, filesDeferred, totalSent };
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
        totalSent += await flushTrace(discoveryMessages, discoveredAgents, logGroupCheckpoints);
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

        const messages = await buildTraceMessagesForLogGroup(events, logGroup, roleNameToResourceMap, harnessNameToResourceMap);
        console.log(`✅ ${logGroup.logGroupName}: ${events.length} log event(s) → ${messages.length} message(s)`);
        logGroupCheckpoints[logGroup.logGroupName] = { lastEventTimestamp: latestTimestamp, runtimeId: logGroup.runtimeId };

        if (messages.length > 0) {
            totalSent += await flushTrace(messages, discoveredAgents, logGroupCheckpoints);
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
 * Main handler. Both pipelines share the same Lambda time budget
 * (context.getRemainingTimeInMillis()) — the S3 pipeline runs first, so a
 * slow S3 backlog can shrink the AgentCore pipeline's share of a given
 * invocation; each pipeline defers its own leftover work to the next run
 * rather than one starving the other outright.
 */
exports.handler = async (event, context) => {
    console.log('🚀 AKTO Bedrock Log Processor started');
    console.log(`📍 Region: ${config.AWS_REGION} | Event: ${event?.source || 'manual'} | Time budget: ${context.getRemainingTimeInMillis()}ms`);
    logMemory('start');

    const timeLeft = () => context.getRemainingTimeInMillis();

    try {
        config.validateConfig();

        const bedrockAgentClassic = await runS3Pipeline(timeLeft);
        logMemory('after S3 pipeline');

        const agentCore = await runAgentCorePipeline(timeLeft);
        logMemory('end');

        return { statusCode: 200, body: JSON.stringify({ bedrockAgentClassic, agentCore }) };

    } catch (error) {
        console.error(`❌ Handler failed: ${error.message}`);
        console.error(error.stack);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
