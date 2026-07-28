/**
 * Lists and processes Bedrock model-invocation log files from S3, turning
 * each raw log entry into AKTO messages via extractors.js + discovery.js.
 */
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { gunzip } = require('zlib');
const { promisify } = require('util');
const { s3Client, LOGS_BUCKET_NAME, LOGS_PREFIX, LOOKBACK_DAYS } = require('./config');
const { extractConversationPairs, extractTraceData } = require('./extractors');
const { fetchAgentName, getHarnessName, getHarnessId, createStandardMessage } = require('./discovery');

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

    // Bedrock delivers offloaded input/output bodies as sibling objects under a `data/`
    // subpath next to the hourly log file (see resolveOffloadedLogEntry in processLogFile
    // below) — those are fetched only by reference via inputBodyS3Path/outputBodyS3Path,
    // never as top-level log files, so they're excluded here.
    const logFiles = allFiles
        .filter((file) => file.Key.endsWith('.gz') && file.Size > 0 && !file.Key.includes('/data/'))
        .sort((a, b) => new Date(a.LastModified) - new Date(b.LastModified));

    const unprocessed = logFiles.filter((file) => new Date(file.LastModified) > startTime);
    console.log(`📊 ${allFiles.length} total objects, ${logFiles.length} .gz log files, ${unprocessed.length} newer than checkpoint`);
    return unprocessed;
}

/** Parses an `s3://bucket/key` URI into { bucket, key }, or null if it isn't one. */
function parseS3Uri(uri) {
    const match = uri?.match(/^s3:\/\/([^/]+)\/(.+)$/);
    return match ? { bucket: match[1], key: match[2] } : null;
}

/**
 * Downloads a body Bedrock offloaded to S3 (input/output too large to inline
 * in the log entry) and parses it back into the same JSON shape inputBodyJson/
 * outputBodyJson would have held. Gunzips only when the key says .gz.
 */
async function fetchOffloadedBody(s3Uri) {
    const parsed = parseS3Uri(s3Uri);
    if (!parsed) return null;
    const s3Object = await s3Client.send(new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }));
    const chunks = [];
    for await (const chunk of s3Object.Body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const text = (parsed.key.endsWith('.gz') ? await gunzipAsync(buffer) : buffer).toString('utf-8');
    return JSON.parse(text);
}

/**
 * Bedrock omits inputBodyJson/outputBodyJson and instead leaves an
 * inputBodyS3Path/outputBodyS3Path pointer when a body is too large to inline
 * (common for agentic ConverseStream calls with big system prompts/tool
 * schemas) — without this, extractConversationPairs silently sees an empty
 * messages array and drops the whole turn. Mutates logEntry in place so
 * extractors.js never has to know offloading exists.
 */
async function resolveOffloadedLogEntry(logEntry) {
    if (logEntry.input?.inputBodyS3Path && !logEntry.input?.inputBodyJson) {
        try {
            console.log(`🔄 Fetching offloaded input body: ${logEntry.input.inputBodyS3Path}`);
            logEntry.input.inputBodyJson = await fetchOffloadedBody(logEntry.input.inputBodyS3Path);
        } catch (error) {
            console.warn(`⚠️ Failed to fetch offloaded input body ${logEntry.input.inputBodyS3Path}: ${error.message}`);
        }
    }
    if (logEntry.output?.outputBodyS3Path && !logEntry.output?.outputBodyJson) {
        try {
            console.log(`🔄 Fetching offloaded output body: ${logEntry.output.outputBodyS3Path}`);
            logEntry.output.outputBodyJson = await fetchOffloadedBody(logEntry.output.outputBodyS3Path);
        } catch (error) {
            console.warn(`⚠️ Failed to fetch offloaded output body ${logEntry.output.outputBodyS3Path}: ${error.message}`);
        }
    }
    return logEntry;
}

/** Downloads, gunzips, and extracts AKTO messages from every log entry in one S3 object. */
async function processLogFile(bucket, key, roleNameToResourceMap) {
    const s3Object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of s3Object.Body) chunks.push(chunk);
    const decompressed = (await gunzipAsync(Buffer.concat(chunks))).toString('utf-8');

    const lines = decompressed.split('\n').filter((line) => line.trim());
    const messages = [];
    for (const line of lines) {
        try {
            messages.push(...await processBedrockLogEntry(JSON.parse(line), roleNameToResourceMap));
        } catch (parseError) {
            console.warn(`⚠️ Skipping unparseable log line in ${key}: ${parseError.message}`);
        }
    }
    console.log(`✅ ${key}: ${lines.length} entries → ${messages.length} message(s)`);
    return messages;
}

/**
 * Turns one raw Bedrock log-entry JSON line into zero or more AKTO messages.
 * roleNameToResourceMap (from discovery.js) lets extractConversationPairs
 * attribute a log entry by its exact execution-role identity rather than
 * guessing from the role's naming convention; resourceName arrives already
 * resolved when that match hits, otherwise falls back to the per-type caches.
 */
async function processBedrockLogEntry(logEntry, roleNameToResourceMap) {
    const messages = [];
    try {
        await resolveOffloadedLogEntry(logEntry);
        const pairs = extractConversationPairs(logEntry, roleNameToResourceMap);
        for (const pair of pairs) {
            if (pair.logType === 'HARNESS') pair.harnessId = pair.harnessId || getHarnessId(pair.harnessRoleSuffix);
            pair.botName = pair.resourceName || (pair.logType === 'AGENT'
                ? await fetchAgentName(pair.agentId)
                : (pair.logType === 'HARNESS' ? getHarnessName(pair.harnessRoleSuffix) : ''));
            pair.traceData = extractTraceData(logEntry, pair.botName);
            messages.push(await createStandardMessage(pair));
        }
    } catch (error) {
        console.error(`❌ Error processing log entry: ${error.message}`);
    }
    return messages;
}

module.exports = { getUnprocessedLogFiles, processLogFile };
