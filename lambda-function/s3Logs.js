/**
 * Lists and processes Bedrock model-invocation log files from S3, turning
 * each raw log entry into AKTO messages via extractors.js + discovery.js.
 */
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { gunzip } = require('zlib');
const { promisify } = require('util');
const { s3Client, LOGS_BUCKET_NAME, LOGS_PREFIX, LOOKBACK_DAYS } = require('./config');
const { extractConversationPairs, extractTraceData } = require('./extractors');
const { fetchAgentName, getHarnessName, createStandardMessage } = require('./discovery');

const gunzipAsync = promisify(gunzip);

/** Resumes from the manifest checkpoint, or falls back to LOOKBACK_DAYS ago if there's no checkpoint or it's stale. */
function getLogsStartTime(manifest) {
    const sevenDaysAgo = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    if (manifest?.lastProcessedTimestamp) {
        const lastRun = new Date(manifest.lastProcessedTimestamp);
        if (lastRun > sevenDaysAgo) {
            console.log(`▶️ Resuming from checkpoint: ${manifest.lastProcessedTimestamp}`);
            return lastRun;
        }
        console.warn(`⚠️ Checkpoint ${manifest.lastProcessedTimestamp} is older than ${LOOKBACK_DAYS} days — resetting to ${sevenDaysAgo.toISOString()}`);
    }
    return sevenDaysAgo;
}

/**
 * Lists every .gz Bedrock log file under LOGS_PREFIX newer than the checkpoint,
 * sorted oldest-first so processing (and the manifest timestamp it advances) is
 * chronological. Paginates through the full bucket listing via ContinuationToken.
 */
async function getUnprocessedLogFiles(manifest) {
    const startTime = getLogsStartTime(manifest);
    let allFiles = [];
    let continuationToken;

    do {
        const response = await s3Client.send(new ListObjectsV2Command({
            Bucket: LOGS_BUCKET_NAME,
            Prefix: LOGS_PREFIX,
            ContinuationToken: continuationToken,
            MaxKeys: 1000
        }));
        allFiles.push(...(response.Contents || []));
        continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    const logFiles = allFiles
        .filter((file) => file.Key.endsWith('.gz') && file.Size > 0)
        .sort((a, b) => new Date(a.LastModified) - new Date(b.LastModified));

    const unprocessed = logFiles.filter((file) => new Date(file.LastModified) > startTime);
    console.log(`📊 ${allFiles.length} total objects, ${logFiles.length} .gz log files, ${unprocessed.length} newer than checkpoint`);
    return unprocessed;
}

/** Downloads, gunzips, and extracts AKTO messages from every log entry in one S3 object. */
async function processLogFile(bucket, key) {
    const s3Object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of s3Object.Body) chunks.push(chunk);
    const decompressed = (await gunzipAsync(Buffer.concat(chunks))).toString('utf-8');

    const lines = decompressed.split('\n').filter((line) => line.trim());
    const messages = [];
    for (const line of lines) {
        try {
            messages.push(...await processBedrockLogEntry(JSON.parse(line)));
        } catch (parseError) {
            console.warn(`⚠️ Skipping unparseable log line in ${key}: ${parseError.message}`);
        }
    }
    console.log(`✅ ${key}: ${lines.length} entries → ${messages.length} message(s)`);
    return messages;
}

/** Turns one raw Bedrock log-entry JSON line into zero or more AKTO messages. */
async function processBedrockLogEntry(logEntry) {
    const messages = [];
    try {
        const pairs = extractConversationPairs(logEntry);
        for (const pair of pairs) {
            pair.botName = pair.logType === 'AGENT'
                ? await fetchAgentName(pair.agentId)
                : (pair.logType === 'HARNESS' ? getHarnessName(pair.harnessRoleSuffix) : '');
            pair.traceData = extractTraceData(logEntry, pair.botName);
            messages.push(await createStandardMessage(pair));
        }
    } catch (error) {
        console.error(`❌ Error processing log entry: ${error.message}`);
    }
    return messages;
}

module.exports = { getUnprocessedLogFiles, processLogFile };
