/**
 * AKTO Amazon Quick processor — entry point.
 *
 * Discovers Amazon Quick agents and MCP connectors in this account and region, reads
 * their chat conversations from S3, and sends both to AKTO.
 *
 * One invocation does four things:
 *   1. Resolve where the chat logs live (quickDelivery.js) — read off the account's
 *      existing CHAT_LOGS delivery, or create that delivery when asked to.
 *   2. Discover agents and MCP connectors (quickDiscovery.js).
 *   3. Read new log objects since the checkpoint and turn each chat record into an AKTO
 *      message (quickLogs.js, quickParser.js, quickMessageBuilder.js).
 *   4. Send, then checkpoint (aktoClient.js, quickManifest.js) — in that order, so a
 *      failed send never advances past data that was not delivered.
 *
 * The checkpoint lives in a central bucket in the Organization management account, under
 * <account-id>/<region>/, so one place holds the org-wide view.
 */
const config = require('./config');
const { sendToDataIngestionService } = require('./aktoClient');
const { getQuickManifest, updateQuickManifest } = require('./quickManifest');
const { getUnprocessedQuickLogFiles, processQuickLogFile, resetQuickStats, getQuickStats, resetQuickFileState } = require('./quickLogs');
const { discoverNewQuickAgents, resetQuickRunState } = require('./quickDiscovery');
const { resolveQuickLogLocation } = require('./quickDelivery');

/** Logs current heap/RSS usage — cheap visibility into memory pressure without waiting for the final Lambda REPORT line. */
function logMemory(label) {
    const { heapUsed, rss } = process.memoryUsage();
    console.log(`🧠 [${label}] heapUsed=${(heapUsed / 1048576).toFixed(0)}MB rss=${(rss / 1048576).toFixed(0)}MB`);
}

/**
 * Prints the configuration actually in effect. Most "it found nothing" reports come down
 * to a bucket, prefix or endpoint differing from what was assumed — having it in the log
 * removes a round trip. Never prints the API key.
 */
function logEffectiveConfig() {
    let ingestHost = 'unset';
    try {
        ingestHost = new URL(config.DATA_INGESTION_ENDPOINT).host;
    } catch { /* validateConfig will already have failed on a blank value */ }

    console.log('⚙️ Effective configuration:');
    console.log(`  ├─ region              ${config.AWS_REGION} (account ${config.AWS_ACCOUNT_ID})`);
    console.log(`  ├─ logging mode        ${config.QUICK_LOGGING_MODE}`);
    console.log(`  ├─ log location        ${config.QUICK_LOGGING_MODE === 'create' ? `will create ${config.QUICK_CREATED_BUCKET_NAME} if absent` : 'discovered from the CHAT_LOGS delivery'}`);
    console.log(`  ├─ checkpoints         s3://${config.MARKERS_BUCKET_NAME}/${config.MARKERS_PREFIX}`);
    console.log(`  ├─ akto ingest host    ${ingestHost} (api key ${config.AKTO_API_KEY ? 'set' : 'MISSING'})`);
    console.log(`  └─ lookback            ${config.QUICK_LOOKBACK_DAYS}d, re-discovery every ${config.QUICK_REDISCOVERY_HOURS}h`);
}

/**
 * Amazon Quick: agents + MCP connectors + chat conversations → AKTO.
 *
 * `timeLeft` is the shrinking work clock; `sendTimeLeft` is the Lambda clock, used for
 * flushes only. Sending is bounded and short, and discarding already-built messages to
 * respect a soft budget would throw away work already paid for.
 */
async function runQuickPipeline(timeLeft, sendTimeLeft) {
    resetQuickStats();
    resetQuickFileState();
    resetQuickRunState();

    const manifest = await getQuickManifest();
    const discoveredAgents = { ...(manifest.discoveredAgents || {}) };
    const actionConnectors = { ...(manifest.actionConnectors || {}) };
    const quickUsers = { ...(manifest.quickUsers || {}) };
    let lastTimestamp = manifest.lastProcessedTimestamp || null;
    let totalSent = 0;

    const failedFiles = [];
    const failedMessages = [];
    let filesDone = 0;
    let filesFailed = 0;
    let filesDeferred = 0;

    /** Sends first, then checkpoints — a failed send must never advance past undelivered data. */
    const flush = async (messages) => {
        let sent = 0;
        if (messages.length > 0) {
            console.log(`📤 Flushing ${messages.length} message(s) to AKTO Ingestion API...`);
            const result = await sendToDataIngestionService(messages, sendTimeLeft || timeLeft);
            sent = result.sent;
            // Permanently refused by the server, so retrying is pointless. Recorded in the
            // manifest as the only durable trace of what was dropped, and the checkpoint
            // advances past them so the rest of the flush is not replayed.
            if (result.quarantined.length > 0) failedMessages.push(...result.quarantined);
            console.log(`✅ Sent ${sent} message(s)${result.quarantined.length ? `, ${result.quarantined.length} quarantined` : ''}`);
        }
        await updateQuickManifest({ discoveredAgents, actionConnectors, quickUsers, lastProcessedTimestamp: lastTimestamp, filesProcessed: filesDone, failedFiles, failedMessages });
        return sent;
    };

    // Where the logs live is resolved at runtime, never configured: in 'discover' mode it
    // comes off the existing CHAT_LOGS delivery (so every account can use a different
    // bucket name), and in 'create' mode the delivery is provisioned first.
    const location = await resolveQuickLogLocation();

    console.log('📋 Discovering Quick agents and MCP connectors...');
    const discoveryMessages = await discoverNewQuickAgents(discoveredAgents, actionConnectors, timeLeft);
    console.log(`✅ Discovery: ${discoveryMessages.length} message(s)`);
    if (discoveryMessages.length > 0) totalSent += await flush(discoveryMessages);

    if (!location) {
        // Agents and connectors were still discovered and sent above — those APIs need no
        // log delivery — but there is no bucket to read conversations from.
        console.warn('⚠️ No readable log location, so no conversations will be ingested this run (discovery above still applied)');
        return { filesDone: 0, filesFailed: 0, filesDeferred: 0, totalSent, traffic: getQuickStats(), noLogLocation: true };
    }
    if (location.justCreated) {
        console.log('🕒 Quick logging was just enabled — AWS batches vended logs roughly every 5 minutes, so the first conversations arrive on a later run');
        return { filesDone: 0, filesFailed: 0, filesDeferred: 0, totalSent, traffic: getQuickStats(), loggingJustEnabled: true };
    }

    const unprocessedFiles = await getUnprocessedQuickLogFiles(manifest, location);
    console.log(`📁 ${unprocessedFiles.length} unprocessed log file(s)`);

    const context = { discoveredAgents, actionConnectors, quickUsers };
    let pending = [];

    for (const file of unprocessedFiles) {
        if (timeLeft() < config.TIME_SAFETY_MARGIN_MS) {
            filesDeferred = unprocessedFiles.length - filesDone - filesFailed;
            console.warn(`⏱️ ${timeLeft()}ms left (below ${config.TIME_SAFETY_MARGIN_MS}ms margin) — stopping early, ${filesDeferred} file(s) deferred to next run`);
            break;
        }

        const fileTs = new Date(file.LastModified).toISOString();
        try {
            pending.push(...await processQuickLogFile(location.bucket, file.Key, context));
            filesDone++;
        } catch (error) {
            // Move past an unreadable object rather than stalling the whole backlog on it,
            // but record it durably so it stays visible after the logs age out.
            filesFailed++;
            failedFiles.push({ key: file.Key, error: error.message, at: new Date().toISOString() });
            console.error(`❌ File FAILED and will NOT be retried: ${file.Key} — ${error.message} (recorded in manifest.failedFiles)`);
        }
        // Advances on success and failure alike: the checkpoint means "read this far",
        // and files are processed oldest-first.
        if (!lastTimestamp || fileTs > lastTimestamp) lastTimestamp = fileTs;

        if (pending.length >= config.FLUSH_THRESHOLD || timeLeft() < config.TIME_SAFETY_MARGIN_MS) {
            totalSent += await flush(pending);
            pending = [];
            logMemory(`checkpoint (${filesDone}/${unprocessedFiles.length} files)`);
        }
    }

    if (pending.length > 0 || filesDone > 0 || filesFailed > 0) {
        totalSent += await flush(pending);
    }

    const stats = getQuickStats();
    console.log(`🎉 Done. Files processed: ${filesDone}, failed: ${filesFailed}, deferred: ${filesDeferred}, messages sent: ${totalSent}, checkpoint: ${lastTimestamp || 'unchanged'}`);
    console.log(`📇 Traffic: ${stats.records} record(s) read → ${stats.chatMessages} chat message(s) ingested, ${stats.nonChatRecords} non-chat record(s) skipped, ${stats.emptyExchanges} with no exchange, ${stats.blocked} blocked/no-answer, ${stats.newAgentsFromLogs} agent(s) discovered from logs, ${stats.unparseableLines} unparseable line(s), ${stats.failed} failed`);
    if (filesFailed > 0) {
        console.warn(`⚠️ ${filesFailed} file(s) were skipped permanently and are listed in manifest.failedFiles — inspect them if data looks missing`);
    }
    return { filesDone, filesFailed, filesDeferred, totalSent, traffic: stats };
}

/**
 * Main handler.
 *
 * The run budget is deliberately shorter than the EventBridge schedule so a run always
 * finishes before the next trigger fires — EventBridge fires on a timer regardless of
 * whether the previous invocation is still running, and two overlapping runs would read
 * the same checkpoint and send duplicates. The Lambda timeout stays as a crash net; this
 * is the normal exit path.
 */
exports.handler = async (event, context) => {
    console.log('🚀 AKTO Amazon Quick processor started');
    console.log(`📍 Region: ${config.AWS_REGION} | Event: ${event?.source || 'manual'} | Time budget: ${context.getRemainingTimeInMillis()}ms`);
    logMemory('start');

    const lambdaTimeLeft = () => context.getRemainingTimeInMillis();
    const startedAt = Date.now();

    /**
     * The clock every worker loop sees: whichever runs out first — the Lambda clock, or
     * this run's wall-clock budget. Expressed as a shrinking timeLeft() so the existing
     * `timeLeft() < TIME_SAFETY_MARGIN_MS` guards need no changes. Once the budget is
     * gone this reports 0, not the margin, or those guards would compare false and the
     * budget would never actually stop anything.
     */
    const timeLeft = () => {
        const budgetRemaining = config.RUN_BUDGET_MS - (Date.now() - startedAt);
        return Math.min(lambdaTimeLeft(), budgetRemaining > 0 ? config.TIME_SAFETY_MARGIN_MS + budgetRemaining : 0);
    };
    const stoppedByBudget = () => config.RUN_BUDGET_MS - (Date.now() - startedAt) <= 0;

    /**
     * Sending is gated on the Lambda clock rather than the run budget. The messages are
     * already collected and a flush takes seconds, so a run may overshoot RUN_BUDGET_MS
     * by the flush duration — a deliberate trade against discarding work already paid for.
     */
    const sendTimeLeft = () => lambdaTimeLeft();

    try {
        config.validateConfig();
        logEffectiveConfig();
        console.log(`  └─ run budget          ${(config.RUN_BUDGET_MS / 1000).toFixed(0)}s of work (schedule is ${(config.SCHEDULE_INTERVAL_MS / 60000).toFixed(0)}min; finishing inside it keeps runs from overlapping)`);

        const quickSuite = await runQuickPipeline(timeLeft, sendTimeLeft);
        logMemory('end');

        // One structured line per run, so CloudWatch Insights can chart throughput and
        // spot deferrals without parsing prose:
        //   fields @timestamp, @message | filter @message like /RUN SUMMARY/
        const summary = {
            durationMs: Date.now() - startedAt,
            runBudgetMs: config.RUN_BUDGET_MS,
            // Which limit ended the run — the schedule-derived budget (expected on a
            // backlog) or the Lambda clock (means the budget is set too high).
            stoppedBy: stoppedByBudget()
                ? 'run-budget'
                : lambdaTimeLeft() < config.TIME_SAFETY_MARGIN_MS
                    ? 'lambda-timeout'
                    : quickSuite.filesDeferred > 0 ? 'deferred-work-remaining' : 'work-complete',
            lambdaTimeLeftMs: lambdaTimeLeft(),
            messagesSent: quickSuite.totalSent,
            quickSuite
        };
        console.log(`📊 RUN SUMMARY ${JSON.stringify(summary)}`);
        if (quickSuite.filesDeferred > 0) {
            console.warn(`⏱️ ${quickSuite.filesDeferred} file(s) deferred to the next run — expected while catching up on a backlog, but persistent deferrals mean the schedule can't keep pace`);
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
