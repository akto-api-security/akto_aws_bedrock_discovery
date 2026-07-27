/**
 * AKTO Bedrock Log Processor — entry point.
 *
 * Reads Bedrock model-invocation logs from S3, discovers agents/harnesses,
 * extracts conversations, and sends everything to AKTO's ingestion API. See
 * the sibling modules for the actual work: config.js, manifest.js, s3Logs.js,
 * extractors.js, discovery.js, messageBuilder.js, aktoClient.js.
 */
const config = require('./config');
const { getManifest, updateManifest } = require('./manifest');
const { getUnprocessedLogFiles, processLogFile } = require('./s3Logs');
const { discoverAllNewAgents, initializeHarnessCache } = require('./discovery');
const { sendToDataIngestionService } = require('./aktoClient');

let harnessInitialized = false;

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
    if (messages.length === 0) return 0;
    await sendToDataIngestionService(messages);
    await updateManifest(filesProcessed, discoveredAgents, lastTimestamp);
    return messages.length;
}

/**
 * Main handler. Time-boxes itself against context.getRemainingTimeInMillis()
 * and flushes (sends to AKTO + checkpoints the manifest) incrementally rather
 * than once at the very end. A timeout or OOM kill mid-run only loses the
 * small batch currently in flight, not the entire backlog — the next
 * scheduled invocation resumes from the last checkpoint instead of
 * restarting the whole lookback window.
 */
exports.handler = async (event, context) => {
    console.log('🚀 AKTO Bedrock Log Processor started');
    console.log(`📍 Region: ${config.AWS_REGION} | Event: ${event?.source || 'manual'} | Time budget: ${context.getRemainingTimeInMillis()}ms`);
    logMemory('start');

    const timeLeft = () => context.getRemainingTimeInMillis();

    try {
        config.validateConfig();

        if (!harnessInitialized) {
            await initializeHarnessCache();
            harnessInitialized = true;
        }

        const manifest = await getManifest();
        const discoveredAgents = { ...(manifest.discoveredAgents || {}) };
        let lastTimestamp = manifest.lastProcessedTimestamp || null;
        let totalSent = 0;

        console.log('📋 Discovering agents/harnesses...');
        const discoveryMessages = await discoverAllNewAgents(discoveredAgents, timeLeft);
        console.log(`✅ Discovery: ${discoveryMessages.length} new resource(s) found`);

        // Flush discovery on its own, immediately — don't let it ride behind log-file
        // processing in the same batch. Discovery is independent of logs (it only
        // needs Bedrock's ListAgents/ListHarnesses APIs).
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
            console.log('✅ Nothing new to process');
        }

        console.log(`🎉 Done. Files processed: ${filesDone}, deferred: ${filesDeferred}, messages sent: ${totalSent}`);
        logMemory('end');

        return { statusCode: 200, body: JSON.stringify({ filesDone, filesDeferred, totalSent }) };

    } catch (error) {
        console.error(`❌ Handler failed: ${error.message}`);
        console.error(error.stack);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
