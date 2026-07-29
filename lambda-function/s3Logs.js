/**
 * Lists and processes Bedrock model-invocation log files from S3, turning
 * each raw log entry into AKTO messages via extractors.js + discovery.js.
 */
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { gunzip } = require('zlib');
const { promisify } = require('util');
const { s3Client, LOGS_BUCKET_NAME, LOGS_PREFIX, LOOKBACK_DAYS } = require('./config');
const { extractConversationPairs, extractTraceData } = require('./extractors');
const { fetchAgentName, getHarnessName, createStandardMessage, findResourceByArn } = require('./discovery');

const gunzipAsync = promisify(gunzip);

/**
 * Parses an S3 path (s3://bucket/key) into bucket and key components.
 * Returns {bucket, key} or null if invalid.
 */
function parseS3Path(s3Path) {
    if (!s3Path || typeof s3Path !== 'string') return null;
    const match = s3Path.match(/^s3:\/\/([^\/]+)\/(.*)/);
    if (!match) return null;
    return { bucket: match[1], key: match[2] };
}

/**
 * Fetches and decompresses a JSON object from an S3 path.
 * S3 paths for Bedrock logs are always .gz compressed.
 * Returns parsed JSON or null on failure.
 */
async function fetchJsonFromS3Path(s3Path) {
    try {
        const parsed = parseS3Path(s3Path);
        if (!parsed) {
            console.warn(`⚠️ Invalid S3 path format: ${s3Path}`);
            return null;
        }

        const { bucket, key } = parsed;
        const s3Object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const chunks = [];
        for await (const chunk of s3Object.Body) chunks.push(chunk);
        const decompressed = await gunzipAsync(Buffer.concat(chunks));
        const jsonData = JSON.parse(decompressed.toString('utf-8'));
        return jsonData;
    } catch (error) {
        console.error(`❌ Failed to fetch from S3 path ${s3Path}: ${error.message}`);
        return null;
    }
}

/**
 * Resolves input body JSON from either direct JSON or S3 path.
 * Returns the input body JSON object or {messages: []} if not found.
 */
async function getInputBodyJson(logEntry) {
    // Check 1: Direct JSON (fast path - most common)
    if (logEntry.input?.inputBodyJson) {
        return logEntry.input.inputBodyJson;
    }

    // Check 2: S3 Reference (slow path - for large payloads)
    if (logEntry.input?.inputBodyS3Path) {
        console.log(`📥 Fetching input from S3: ${logEntry.input.inputBodyS3Path}`);
        const data = await fetchJsonFromS3Path(logEntry.input.inputBodyS3Path);
        if (data) return data;
    }

    // Fallback: Return empty
    console.warn(`⚠️ No input data found (neither direct JSON nor S3 path)`);
    return { messages: [] };
}

/**
 * Resolves output body JSON from either direct JSON or S3 path.
 * Returns the output body JSON object or {output: {message: {content: []}}} if not found.
 */
async function getOutputBodyJson(logEntry) {
    // Check 1: Direct JSON (fast path - most common)
    if (logEntry.output?.outputBodyJson) {
        return logEntry.output.outputBodyJson;
    }

    // Check 2: S3 Reference (slow path - for large payloads)
    if (logEntry.output?.outputBodyS3Path) {
        console.log(`📤 Fetching output from S3: ${logEntry.output.outputBodyS3Path}`);
        const data = await fetchJsonFromS3Path(logEntry.output.outputBodyS3Path);
        if (data) return data;
    }

    // Fallback: Return empty
    console.warn(`⚠️ No output data found (neither direct JSON nor S3 path)`);
    return { output: { message: { content: [] } } };
}

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
        // Resolve resource from ARN using discovery mappings
        const resource = findResourceByArn(logEntry.identity?.arn);
        if (!resource) {
            console.warn(`⚠️ Skipping log entry - cannot determine resource from ARN`);
            return messages;
        }

        // Resolve input/output body JSON (handles both direct JSON and S3 paths)
        const resolvedInputBody = await getInputBodyJson(logEntry);
        const resolvedOutputBody = await getOutputBodyJson(logEntry);

        // Update logEntry with resolved data for extractConversationPairs
        if (resolvedInputBody) logEntry.input = { ...logEntry.input, inputBodyJson: resolvedInputBody };
        if (resolvedOutputBody) logEntry.output = { ...logEntry.output, outputBodyJson: resolvedOutputBody };

        const pairs = extractConversationPairs(logEntry);
        for (const pair of pairs) {
            // Populate from discovered resource
            pair.logType = resource.type;
            if (resource.type === 'AGENT') {
                pair.agentId = resource.agentId;
                pair.botName = await fetchAgentName(resource.agentId);
            } else if (resource.type === 'HARNESS') {
                pair.harnessId = resource.harnessId;
                pair.harnessName = resource.harnessName;
                pair.botName = resource.harnessName;
            } else if (resource.type === 'STANDALONE_RUNTIME') {
                pair.runtimeAgentId = resource.agentId;
                pair.agentId = resource.agentId;
                pair.botName = resource.agentName;
            }

            pair.traceData = extractTraceData(logEntry, pair.botName);
            messages.push(await createStandardMessage(pair));
        }
    } catch (error) {
        console.error(`❌ Error processing log entry: ${error.message}`);
    }
    return messages;
}

module.exports = { getUnprocessedLogFiles, processLogFile };
