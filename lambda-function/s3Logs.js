/**
 * Lists and processes Bedrock model-invocation log files from S3, turning
 * each raw log entry into AKTO messages via extractors.js + discovery.js.
 */
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { gunzip } = require('zlib');
const { promisify } = require('util');
const config = require('./config');
const { LOGS_BUCKET_NAME, LOGS_PREFIX, LOOKBACK_DAYS } = config;
const { extractConversationPairs, extractTraceData } = require('./extractors');
const { fetchAgentName, createStandardMessage, findResourceByArn, buildServiceAgentDiscoveryMessage } = require('./discovery');

const gunzipAsync = promisify(gunzip);

const logStats = {
    agentCalls: 0,              // resolved to a discovered Bedrock Agent — ingested
    serviceAgentIngested: 0,        // an app or person calling a model directly — ingested, named after the caller
    serviceAgentCalls: 0,           // dropped: shared role the session couldn't narrow, or ingestion turned off
    noIdentity: 0,              // no usable identity ARN at all
    noConversation: 0,          // parsed fine, but carried no complete exchange
    unparseableLines: 0
};
function resetLogStats() { for (const key of Object.keys(logStats)) logStats[key] = 0; }
function getLogStats() { return { ...logStats }; }

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
        const s3Object = await config.s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
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
    const lookbackCutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    if (manifest?.lastProcessedTimestamp) {
        const lastRun = new Date(manifest.lastProcessedTimestamp);
        if (lastRun > lookbackCutoff) {
            console.log(`▶️ Resuming from checkpoint: ${manifest.lastProcessedTimestamp}`);
            return lastRun;
        }
        console.warn(`⚠️ Checkpoint ${manifest.lastProcessedTimestamp} is older than ${LOOKBACK_DAYS} days — resetting to ${lookbackCutoff.toISOString()}`);
    }
    return lookbackCutoff;
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
    let pages = 0;

    // Name the exact location being read: a wrong LOGS_PREFIX is the single most
    // common reason discovery finds nothing, and it is invisible from counts alone.
    console.log(`🪣 Listing s3://${LOGS_BUCKET_NAME}/${LOGS_PREFIX} for .gz logs newer than ${startTime.toISOString()}`);

    do {
        const response = await config.s3Client.send(new ListObjectsV2Command({
            Bucket: LOGS_BUCKET_NAME,
            Prefix: LOGS_PREFIX,
            ContinuationToken: continuationToken,
            MaxKeys: 1000
        }));
        allFiles.push(...(response.Contents || []));
        continuationToken = response.NextContinuationToken;
        pages++;
    } while (continuationToken);

    /*
     * Bedrock writes large request/response bodies as separate objects under a
     * `data/` folder in this same prefix, and the log entry that owns one points at
     * it with inputBodyS3Path. Those bodies are NOT log entries — they carry no
     * identity, timestamp or model — so reading them as log files costs a GET, a
     * gunzip and a parse to produce nothing, and inflates the "no usable identity"
     * count with things that were never identities.
     *
     * They are still fully read, just through their owning entry (getInputBodyJson),
     * which is the only path that has the context to turn them into a message.
     */
    const isBodyObject = (key) => key.includes('/data/');
    const bodyObjects = allFiles.filter((file) => file.Key.endsWith('.gz') && isBodyObject(file.Key)).length;

    const logFiles = allFiles
        .filter((file) => file.Key.endsWith('.gz') && file.Size > 0 && !isBodyObject(file.Key))
        .sort((a, b) => new Date(a.LastModified) - new Date(b.LastModified));

    const unprocessed = logFiles.filter((file) => new Date(file.LastModified) > startTime);
    console.log(`📊 ${allFiles.length} object(s) across ${pages} page(s), ${logFiles.length} .gz log file(s), ${unprocessed.length} newer than checkpoint`);
    if (bodyObjects > 0) {
        console.log(`📦 ${bodyObjects} large-payload body object(s) under data/ skipped in the listing — they are fetched via inputBodyS3Path by the entries that own them`);
    }

    // Turn each "nothing to do" case into a specific, actionable reason.
    if (allFiles.length === 0) {
        console.warn(`⚠️ Nothing at s3://${LOGS_BUCKET_NAME}/${LOGS_PREFIX} — check LOGS_PREFIX matches where Bedrock actually delivers, and that model invocation logging is enabled for this account/region`);
    } else if (logFiles.length === 0) {
        const sample = allFiles.slice(0, 3).map((f) => f.Key).join(', ');
        console.warn(`⚠️ Objects exist under the prefix but none are .gz Bedrock logs. First key(s): ${sample} — LOGS_PREFIX may be pointing at the wrong level`);
    } else if (unprocessed.length === 0) {
        const newest = logFiles[logFiles.length - 1];
        console.log(`✅ Up to date — newest log file is ${newest.Key} (${new Date(newest.LastModified).toISOString()}), at or before the checkpoint`);
    } else {
        console.log(`📄 Oldest unprocessed: ${unprocessed[0].Key} (${new Date(unprocessed[0].LastModified).toISOString()})`);
    }
    return unprocessed;
}

/**
 * Downloads, gunzips, and extracts AKTO messages from every log entry in one S3 object.
 * `discoveredAgents` is passed through so a first-seen SERVICE_AGENT caller (no ListAgents-
 * style API exists to discover those upfront) gets its one-time discovery message the
 * moment its first log entry is read, and is recorded so it isn't sent again.
 */
async function processLogFile(bucket, key, discoveredAgents) {
    const s3Object = await config.s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of s3Object.Body) chunks.push(chunk);
    const decompressed = (await gunzipAsync(Buffer.concat(chunks))).toString('utf-8');

    const lines = decompressed.split('\n').filter((line) => line.trim());
    const messages = [];
    for (const line of lines) {
        try {
            messages.push(...await processBedrockLogEntry(JSON.parse(line), discoveredAgents));
        } catch (parseError) {
            logStats.unparseableLines++;
            console.warn(`⚠️ Skipping unparseable log line in ${key}: ${parseError.message}`);
        }
    }
    console.log(`✅ ${key}: ${lines.length} entries → ${messages.length} message(s)`);
    return messages;
}

/** Turns one raw Bedrock log-entry JSON line into zero or more AKTO messages. */
async function processBedrockLogEntry(logEntry, discoveredAgents) {
    const messages = [];
    try {
        // Resolve resource from ARN using discovery mappings. Only traffic that maps
        // to a discovered agent is ingested — a model invoked directly by an
        // application or a person is out of scope for this pipeline and is skipped.
        const resource = findResourceByArn(logEntry.identity?.arn);
        if (!resource) {
            // Either no identity at all, or a shared role the session couldn't narrow.
            // Everything else — including traffic no agent owns — comes back resolved.
            if (logEntry.identity?.arn) logStats.serviceAgentCalls++;
            else logStats.noIdentity++;
            return messages;
        }

        // Resolve input/output body JSON (handles both direct JSON and S3 paths)
        const resolvedInputBody = await getInputBodyJson(logEntry);
        const resolvedOutputBody = await getOutputBodyJson(logEntry);

        // Update logEntry with resolved data for extractConversationPairs
        if (resolvedInputBody) logEntry.input = { ...logEntry.input, inputBodyJson: resolvedInputBody };
        if (resolvedOutputBody) logEntry.output = { ...logEntry.output, outputBodyJson: resolvedOutputBody };

        if (resource.type === 'AGENT') logStats.agentCalls++;
        else if (resource.type === 'SERVICE_AGENT') logStats.serviceAgentIngested++;

        const pairs = extractConversationPairs(logEntry);
        if (pairs.length === 0) logStats.noConversation++;
        for (const pair of pairs) {
            // Populate from discovered resource
            pair.logType = resource.type;
            if (resource.type === 'AGENT') {
                pair.agentId = resource.agentId;
                // Name and execution role both come from the role map (i.e. the
                // manifest), so neither costs a GetAgent call.
                pair.botName = await fetchAgentName(resource.agentId, resource.agentName);
                pair.executionRoleArn = resource.executionRoleArn || '';
            } else if (resource.type === 'SERVICE_AGENT') {
                // Direct model invocation: attributed to the calling principal. Reuses
                // the agent-id tag slot — a caller has no AWS resource ID of its own,
                // but still needs a stable, non-empty identity to be discovered/grouped by.
                pair.agentId = resource.callerName;
                pair.botName = resource.callerName;
                pair.callerKind = resource.callerKind;

                // No ListAgents-equivalent API enumerates callers upfront, so this is the
                // only place a SERVICE_AGENT caller can be recognized as first-seen — persisted
                // into discoveredAgents (same manifest-backed map real agents use) so the
                // discovery message goes out exactly once per caller, not once per log entry.
                const serviceAgentKey = `serviceagent-${resource.callerName}`;
                if (discoveredAgents && !discoveredAgents[serviceAgentKey]) {
                    messages.push(buildServiceAgentDiscoveryMessage(resource, logEntry));
                    discoveredAgents[serviceAgentKey] = {
                        resourceId: resource.callerName,
                        resourceType: 'SERVICE_AGENT',
                        resourceName: resource.callerName,
                        callerKind: resource.callerKind,
                        discoveredAt: new Date().toISOString()
                    };
                }
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

module.exports = { getUnprocessedLogFiles, processLogFile, resetLogStats, getLogStats };
