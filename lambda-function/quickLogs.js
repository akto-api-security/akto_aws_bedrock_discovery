/**
 * Lists and processes Amazon Quick Suite chat-log files from S3, turning each record
 * into AKTO messages via quickParser.js + quickDiscovery.js.
 *
 * The listing/checkpoint logic is deliberately the same as s3Logs.js — same
 * ListObjectsV2 pagination, same "newer than the checkpoint, oldest first" ordering,
 * same actionable diagnostics when nothing is found. Only the object *contents* differ,
 * which is what quickParser.js handles.
 */
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { gunzip } = require('zlib');
const { promisify } = require('util');
const { s3Client, QUICK_LOOKBACK_DAYS, AWS_ACCOUNT_ID } = require('./config');
const { parseQuickRecord, isChatLog, logTypeOf, missingOptionalFields } = require('./quickParser');
const { createQuickStandardMessage, discoverAgentFromLogs } = require('./quickDiscovery');

const gunzipAsync = promisify(gunzip);

const quickStats = {
    records: 0,             // records read across all files
    chatMessages: 0,        // chat records that produced an AKTO message
    nonChatRecords: 0,      // FEEDBACK_LOGS / AGENT_HOURS_LOGS / etc. sharing the prefix
    emptyExchanges: 0,      // chat records with neither a user nor a system message
    blocked: 0,             // status_code was not 'success' (request_blocked, no_answer_found)
    newAgentsFromLogs: 0,   // agent ids discovered from the logs (SYSTEM, flows)
    unparseableLines: 0,
    failed: 0
};
function resetQuickStats() { for (const key of Object.keys(quickStats)) quickStats[key] = 0; }
function getQuickStats() { return { ...quickStats }; }

/** Reported once per run, not once per record — a busy account has one answer, not thousands. */
let warnedMissingOptionalFields = false;
const seenNonChatTypes = new Set();
function resetQuickFileState() { warnedMissingOptionalFields = false; seenNonChatTypes.clear(); }

/** Resumes from the manifest checkpoint, or falls back to QUICK_LOOKBACK_DAYS ago if there's no checkpoint or it's stale. */
function getQuickLogsStartTime(manifest) {
    const lookbackCutoff = new Date(Date.now() - QUICK_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    if (manifest?.lastProcessedTimestamp) {
        const lastRun = new Date(manifest.lastProcessedTimestamp);
        if (lastRun > lookbackCutoff) {
            console.log(`▶️ Resuming Quick from checkpoint: ${manifest.lastProcessedTimestamp}`);
            return lastRun;
        }
        console.warn(`⚠️ Quick checkpoint ${manifest.lastProcessedTimestamp} is older than ${QUICK_LOOKBACK_DAYS} days — resetting to ${lookbackCutoff.toISOString()}`);
    }
    return lookbackCutoff;
}

/**
 * Lists every Quick log object under QUICK_LOGS_PREFIX newer than the checkpoint,
 * sorted oldest-first so the manifest timestamp advances chronologically.
 *
 * Unlike the Bedrock listing this does not require a .gz suffix: the delivery's output
 * format and compression are configurable per delivery (CreateDelivery), so plain JSON
 * objects are just as valid. Empty objects are still skipped, and readQuickObject()
 * sniffs compression from the bytes rather than the file name.
 */
async function getUnprocessedQuickLogFiles(manifest, location) {
    const { bucket: QUICK_LOGS_BUCKET_NAME, prefix: QUICK_LOGS_PREFIX } = location;
    const startTime = getQuickLogsStartTime(manifest);
    const allFiles = [];
    let continuationToken;
    let pages = 0;

    console.log(`🪣 Listing s3://${QUICK_LOGS_BUCKET_NAME}/${QUICK_LOGS_PREFIX} for Quick chat logs newer than ${startTime.toISOString()}`);

    do {
        const response = await s3Client.send(new ListObjectsV2Command({
            Bucket: QUICK_LOGS_BUCKET_NAME,
            Prefix: QUICK_LOGS_PREFIX,
            ContinuationToken: continuationToken,
            MaxKeys: 1000
        }));
        allFiles.push(...(response.Contents || []));
        continuationToken = response.NextContinuationToken;
        pages++;
    } while (continuationToken);

    const logFiles = allFiles
        .filter((file) => file.Size > 0 && !file.Key.endsWith('/'))
        .sort((a, b) => new Date(a.LastModified) - new Date(b.LastModified));

    const unprocessed = logFiles.filter((file) => new Date(file.LastModified) > startTime);
    console.log(`📊 Quick: ${allFiles.length} object(s) across ${pages} page(s), ${logFiles.length} candidate log file(s), ${unprocessed.length} newer than checkpoint`);

    // The derived prefix (AWSLogs/<account>/quicksuitelogs/) follows AWS's observed
    // naming rather than a documented guarantee. If it matches nothing, fall back to the
    // broader AWSLogs/ before concluding there are no logs — a wrong guess here would
    // look identical to an account with no traffic.
    if (allFiles.length === 0 && QUICK_LOGS_PREFIX !== 'AWSLogs/' && QUICK_LOGS_PREFIX.startsWith('AWSLogs/')) {
        console.log(`↩️ Nothing under ${QUICK_LOGS_PREFIX} — retrying with the broader prefix AWSLogs/`);
        return getUnprocessedQuickLogFiles(manifest, { ...location, prefix: 'AWSLogs/' });
    }

    // Turn each "nothing to do" case into a specific, actionable reason.
    if (allFiles.length === 0) {
        /*
         * An empty listing has two very different causes and they need different fixes.
         *
         * When the bucket belongs to someone else — a shared org-wide log bucket, or a
         * delivery someone configured earlier — the usual cause is that its policy does not
         * authorise this account. That failure is silent everywhere else: the delivery is
         * created successfully, reports healthy, and simply never receives anything. Saying
         * so here is the only place it surfaces.
         */
        if (location.sharedBucket) {
            console.warn(`⚠️ Nothing at s3://${QUICK_LOGS_BUCKET_NAME}/${QUICK_LOGS_PREFIX}. This bucket is not managed by this account, so the likeliest cause is its bucket policy. It must (a) allow delivery.logs.amazonaws.com to s3:PutObject on AWSLogs/${AWS_ACCOUNT_ID}/*, or nothing is ever written, and (b) allow this account to s3:GetObject and s3:ListBucket the same prefix, or nothing can be read back. Note a delivery can exist and look healthy while (a) is missing.`);
        } else {
            console.warn(`⚠️ Nothing at s3://${QUICK_LOGS_BUCKET_NAME}/${QUICK_LOGS_PREFIX} — check the prefix matches where the CHAT_LOGS delivery actually writes, and that the delivery exists for this account`);
        }
    } else if (unprocessed.length === 0) {
        const newest = logFiles[logFiles.length - 1];
        if (newest) console.log(`✅ Quick up to date — newest log file is ${newest.Key} (${new Date(newest.LastModified).toISOString()}), at or before the checkpoint`);
    } else {
        console.log(`📄 Oldest unprocessed Quick file: ${unprocessed[0].Key} (${new Date(unprocessed[0].LastModified).toISOString()})`);
    }
    return unprocessed;
}

/**
 * Downloads one object and returns its text, decompressing only if the bytes actually
 * say gzip (0x1f 0x8b). Sniffing beats trusting the extension here because the
 * delivery's compression is a per-delivery setting rather than a fixed convention.
 */
async function readQuickObject(bucket, key) {
    const s3Object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = [];
    for await (const chunk of s3Object.Body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    const isGzip = buffer.length > 1 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    return (isGzip ? await gunzipAsync(buffer) : buffer).toString('utf-8');
}

/**
 * Splits one object's text into individual log records.
 *
 * Three layouts are accepted, because the delivery's output format is configurable and
 * a wrong guess here would silently drop an entire account's traffic:
 *   - a JSON array of records
 *   - a single JSON object, either one record or a {logEvents:[{message}]} envelope
 *   - newline-delimited JSON, the usual vended-log layout
 */
function parseQuickRecords(text, key) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];

    if (trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) return parsed;
        } catch (error) {
            console.warn(`⚠️ ${key}: looked like a JSON array but failed to parse (${error.message}) — falling back to line-by-line`);
        }
    }

    if (trimmed.startsWith('{')) {
        try {
            const parsed = JSON.parse(trimmed);
            // CloudWatch-style envelope: the real records are JSON strings inside .message.
            if (Array.isArray(parsed.logEvents)) {
                return parsed.logEvents.map((event) => {
                    if (event && typeof event.message === 'string') {
                        try { return JSON.parse(event.message); } catch { return null; }
                    }
                    return event?.message || event;
                }).filter(Boolean);
            }
            return [parsed];
        } catch {
            // Almost certainly newline-delimited JSON, which never parses whole — fall through.
        }
    }

    const records = [];
    for (const line of trimmed.split('\n')) {
        const candidate = line.trim();
        if (!candidate) continue;
        try {
            records.push(JSON.parse(candidate));
        } catch (error) {
            quickStats.unparseableLines++;
            console.warn(`⚠️ Skipping unparseable Quick log line in ${key}: ${error.message}`);
        }
    }
    return records;
}

/**
 * Reads one Quick log object and turns every chat record in it into AKTO messages.
 *
 * `context` carries the manifest-backed maps (discoveredAgents, actionConnectors,
 * quickUsers), all mutated in place: an agent id seen here for the first time — almost
 * always 'SYSTEM', which ListAgents never returns — gets its one-time discovery
 * message emitted right here, the same way s3Logs.js handles a first-seen direct
 * model caller.
 */
async function processQuickLogFile(bucket, key, context) {
    const text = await readQuickObject(bucket, key);
    const records = parseQuickRecords(text, key);

    const messages = [];
    for (const record of records) {
        quickStats.records++;
        try {
            if (!isChatLog(record)) {
                quickStats.nonChatRecords++;
                const type = logTypeOf(record);
                // One line per distinct non-chat type per run: a shared prefix is a
                // legitimate setup, but it should be visible that it's happening.
                if (!seenNonChatTypes.has(type)) {
                    seenNonChatTypes.add(type);
                    console.log(`ℹ️ Skipping '${type}' records under this prefix — only CHAT_LOGS produce conversations`);
                }
                continue;
            }

            const pair = parseQuickRecord(record);
            if (!pair) { quickStats.emptyExchanges++; continue; }
            if (pair.statusCode && pair.statusCode.toLowerCase() !== 'success') quickStats.blocked++;

            if (!warnedMissingOptionalFields && missingOptionalFields(pair)) {
                warnedMissingOptionalFields = true;
                console.warn('⚠️ Quick chat records carry none of namespace/latency/time_to_first_token/surface_type/web_search — AWS does not deliver these by default. To capture them, name them in the recordFields of the CreateDelivery call that set up this log delivery.');
            }

            // ListAgents only returns PUBLISHED agents, so a draft's PREVIEW id — and the
            // built-in SYSTEM agent on some accounts — is first seen here. Recorded into
            // discoveredAgents so the discovery message goes out once per agent, not once
            // per record. discoverAgentFromLogs resolves the real name via DescribeAgent,
            // which works on ids ListAgents omits.
            const agentKey = `quick-agent-${pair.agentId}`;
            if (pair.agentId && !context.discoveredAgents[agentKey]) {
                messages.push(await discoverAgentFromLogs(pair.agentId, pair, context.actionConnectors, context.discoveredAgents));
                quickStats.newAgentsFromLogs++;
            }

            messages.push(await createQuickStandardMessage(pair, context));
            quickStats.chatMessages++;
        } catch (error) {
            quickStats.failed++;
            console.error(`❌ Error processing Quick record in ${key}: ${error.message}`);
        }
    }

    console.log(`✅ ${key}: ${records.length} record(s) → ${messages.length} message(s)`);
    return messages;
}

module.exports = {
    getUnprocessedQuickLogFiles, processQuickLogFile, readQuickObject, parseQuickRecords,
    resetQuickStats, getQuickStats, resetQuickFileState
};
