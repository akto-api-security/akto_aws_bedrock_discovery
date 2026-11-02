/**
 * Lists and processes Bedrock model-invocation log files from S3, turning
 * each raw log entry into AKTO messages via extractors.js + discovery.js.
 */
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { pipeline } = require('stream/promises');
const { StringDecoder } = require('string_decoder');
const { gunzip, createGunzip } = require('zlib');
const { promisify } = require('util');
const {
    s3Client, LOGS_BUCKET_NAME, LOGS_PREFIX, LOOKBACK_DAYS, MAX_CATCHUP_DAYS, LISTING_SLACK_MS, TIME_SAFETY_MARGIN_MS
} = require('./config');
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

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/*
 * Bedrock writes large request/response bodies as separate objects under a `data/`
 * folder in this same prefix, and the log entry that owns one points at it with
 * inputBodyS3Path. Those bodies are NOT log entries — they carry no identity, timestamp
 * or model — so reading them as log files costs a GET, a gunzip and a parse to produce
 * nothing, and inflates the "no usable identity" count with things that were never
 * identities.
 *
 * They are still fully read, just through their owning entry (getInputBodyJson), which
 * is the only path that has the context to turn them into a message.
 */
const isBodyObject = (key) => key.includes('/data/');
const isLogFile = (object) => object.Key.endsWith('.gz') && object.Size > 0 && !isBodyObject(object.Key);
const lastModifiedMs = (object) => new Date(object.LastModified).getTime();
// Oldest first, key as the tie-break so files sharing one second come out in a stable order.
const byLastModified = (a, b) => lastModifiedMs(a) - lastModifiedMs(b) || (a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0);

/**
 * Where reading resumes: the manifest checkpoint, or LOOKBACK_DAYS ago when there is
 * none, or MAX_CATCHUP_DAYS ago when the checkpoint is older than that.
 *
 * S3's LastModified has one-second resolution, and a busy account writes several files
 * in the same second. `keysAtCheckpoint` are the files already read at exactly the
 * checkpoint second, so a file sharing that second is still picked up instead of being
 * skipped by a strict "newer than" test. A manifest written before this field existed
 * has none, and keeps the original strict comparison — upgrading never re-reads a file.
 */
function getResumePoint(manifest) {
    const now = Date.now();
    const checkpoint = manifest?.lastProcessedTimestamp ? new Date(manifest.lastProcessedTimestamp).getTime() : NaN;

    if (Number.isNaN(checkpoint)) {
        const startMs = now - LOOKBACK_DAYS * DAY_MS;
        console.log(`🆕 No checkpoint — reading the last ${LOOKBACK_DAYS} day(s), from ${new Date(startMs).toISOString()}`);
        return { startMs, keysAtCheckpoint: null };
    }
    const catchupFloor = now - MAX_CATCHUP_DAYS * DAY_MS;
    if (checkpoint < catchupFloor) {
        console.warn(`⚠️ Checkpoint ${manifest.lastProcessedTimestamp} is older than ${MAX_CATCHUP_DAYS} days — resetting to ${new Date(catchupFloor).toISOString()}; logs in between are NOT read`);
        return { startMs: catchupFloor, keysAtCheckpoint: null };
    }
    console.log(`▶️ Resuming from checkpoint: ${manifest.lastProcessedTimestamp}`);
    const keys = Array.isArray(manifest.processedKeysAtCheckpoint) ? new Set(manifest.processedKeysAtCheckpoint) : null;
    return { startMs: checkpoint, keysAtCheckpoint: keys };
}

/** Is this log file after the resume point — including a same-second file not yet read? */
function isUnprocessed(file, { startMs, keysAtCheckpoint }) {
    const modified = lastModifiedMs(file);
    if (modified > startMs) return true;
    return modified === startMs && keysAtCheckpoint !== null && !keysAtCheckpoint.has(file.Key);
}

/** Runs out of time between S3 calls rather than mid-call. */
const outOfTime = (timeLeft) => timeLeft() < TIME_SAFETY_MARGIN_MS;

/** One ListObjectsV2 page. */
function listPage(prefix, continuationToken, delimiter) {
    return s3Client.send(new ListObjectsV2Command({
        Bucket: LOGS_BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        Delimiter: delimiter,
        MaxKeys: 1000
    }));
}

// A level of a Bedrock layout has a handful of sub-folders (accounts, regions, years),
// all on the first page. More than this many pages means a flat prefix of files, which
// is not a dated layout — stop rather than page through it.
const MAX_FOLDER_LISTING_PAGES = 3;

/** The immediate sub-folders of a prefix, or null if it is too large to be a folder level. */
async function listSubFolders(prefix) {
    const folders = [];
    let continuationToken;
    for (let page = 0; page < MAX_FOLDER_LISTING_PAGES; page++) {
        const response = await listPage(prefix, continuationToken, '/');
        for (const common of response.CommonPrefixes || []) folders.push(common.Prefix);
        continuationToken = response.NextContinuationToken;
        if (!continuationToken) return folders;
    }
    return null;
}

const YEAR_FOLDER = /^\d{4}\/$/;
const TWO_DIGIT_FOLDER = /^\d{2}\/$/;
const childName = (parent, folder) => folder.slice(parent.length);
// Deep enough for <keyPrefix>/AWSLogs/<account>/BedrockModelInvocationLogs/<region>/.
const MAX_LAYOUT_DEPTH = 5;
const MAX_FOLDERS_PER_LEVEL = 50;

/**
 * Finds the folders under LOGS_PREFIX that directly contain year folders — for
 * Bedrock, `…/AWSLogs/<account>/BedrockModelInvocationLogs/<region>/` — and whether
 * each day below them is split into hour folders.
 *
 * A few small listings, independent of how many log files exist. Returns [] when the
 * prefix does not look like Bedrock's dated layout, so the caller can fall back.
 */
async function findDatedRoots(timeLeft) {
    const roots = [];
    let level = [LOGS_PREFIX];
    for (let depth = 0; depth <= MAX_LAYOUT_DEPTH && level.length > 0; depth++) {
        const next = [];
        for (const prefix of level) {
            if (outOfTime(timeLeft)) return [];
            const folders = await listSubFolders(prefix);
            if (!folders) continue;
            const years = folders.filter((folder) => YEAR_FOLDER.test(childName(prefix, folder))).sort();
            if (years.length > 0) roots.push({ prefix, latestYear: years[years.length - 1] });
            else next.push(...folders.filter((folder) => childName(prefix, folder) !== 'data/'));
        }
        if (next.length > MAX_FOLDERS_PER_LEVEL) break;
        level = next;
    }

    // An AWSLogs/ prefix also holds other services' dated logs (CloudTrail, ELB, …).
    // When Bedrock's own folders are there, read only those.
    const bedrockRoots = roots.filter((root) => root.prefix.includes('/BedrockModelInvocationLogs/'));
    const chosen = bedrockRoots.length > 0 ? bedrockRoots : roots;

    const resolved = [];
    for (const root of chosen) {
        const unitMs = await detectFolderUnit(root.latestYear);
        if (unitMs) resolved.push({ prefix: root.prefix, unitMs });
    }
    return resolved;
}

/** Follows the newest year → month → day and reports whether days hold hour folders. */
async function detectFolderUnit(yearFolder) {
    let folder = yearFolder;
    for (const level of ['month', 'day']) {
        const children = ((await listSubFolders(folder)) || []).filter((f) => TWO_DIGIT_FOLDER.test(childName(folder, f))).sort();
        if (children.length === 0) {
            console.warn(`⚠️ ${yearFolder} has no ${level} folders — not treating it as a dated log layout`);
            return null;
        }
        folder = children[children.length - 1];
    }
    const hours = ((await listSubFolders(folder)) || []).filter((f) => TWO_DIGIT_FOLDER.test(childName(folder, f)));
    return hours.length > 0 ? HOUR_MS : DAY_MS;
}

const pad = (n) => String(n).padStart(2, '0');

/** The dated folder (UTC, like Bedrock's key names) that holds time `ms`. */
function folderFor(rootPrefix, ms, unitMs) {
    const d = new Date(ms);
    const day = `${rootPrefix}${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/`;
    return unitMs === HOUR_MS ? `${day}${pad(d.getUTCHours())}/` : day;
}

/**
 * A log file may sit in a folder up to this much LATER than its LastModified suggests
 * (clock skew between the writer and S3). Files are only handed out once every folder
 * that could hold them has been listed.
 */
const FOLDER_SKEW_MS = 15 * 60 * 1000;

/**
 * Opens a cursor over the unprocessed log files, handed out oldest first in batches.
 *
 * Bedrock's dated layout lets this read only the folders between the checkpoint and
 * now, one hour (or day) at a time: memory and S3 calls depend on how much traffic
 * arrived since the checkpoint, never on how much history the bucket holds. Listing a
 * multi-year bucket in full is what used to exhaust the Lambda before it read a file.
 *
 *   next()      — the next batch of files in LastModified order, or null when there are
 *                 no more or time ran out (see `complete`)
 *   buffered()  — files already listed but not yet handed out
 *   complete    — true once every folder up to now has been listed
 *
 * Batches come out in strict LastModified order across folders: a file is held back
 * until every folder that could contain an earlier file has been listed, because a
 * late-delivered file can sit in the previous hour's folder. That ordering is what lets
 * the checkpoint be a single timestamp.
 *
 * A prefix that does not follow the dated layout falls back to listing it once in full,
 * keeping only unprocessed files and stopping at the time budget.
 */
async function openLogFileCursor(manifest, timeLeft) {
    const resume = getResumePoint(manifest);
    const roots = await findDatedRoots(timeLeft);
    if (roots.length === 0) return openFullListingCursor(resume, timeLeft);

    const now = Date.now();
    const unitMs = Math.min(...roots.map((root) => root.unitMs));
    let folderTime = Math.floor((resume.startMs - LISTING_SLACK_MS) / unitMs) * unitMs;
    let held = [];
    let objectsSeen = 0;
    let filesFound = 0;
    let foldersListed = 0;

    console.log(`🪣 Reading ${roots.length > 1 ? `${roots.length} dated log folders` : 'dated log folders'} under s3://${LOGS_BUCKET_NAME}/${LOGS_PREFIX} by ${unitMs === HOUR_MS ? 'hour' : 'day'}: ${roots.map((root) => root.prefix).join(', ')}`);
    console.log(`📅 Window: ${folderFor(roots[0].prefix, folderTime, unitMs).slice(roots[0].prefix.length)} → now (unprocessed files newer than ${new Date(resume.startMs).toISOString()})`);

    const cursor = {
        complete: false,
        buffered: () => held.length,
        async next() {
            while (folderTime <= now) {
                for (const root of roots) {
                    const folder = folderFor(root.prefix, folderTime, root.unitMs);
                    // A day-foldered root next to an hour-foldered one: list its day once.
                    if (folder === root.lastFolder) continue;
                    let continuationToken;
                    do {
                        if (outOfTime(timeLeft)) {
                            console.warn(`⏱️ Time budget reached while listing ${folder} — the remaining folders are read next run`);
                            return null;
                        }
                        const response = await listPage(folder, continuationToken);
                        for (const object of response.Contents || []) {
                            objectsSeen++;
                            if (isLogFile(object) && isUnprocessed(object, resume)) {
                                held.push({ Key: object.Key, LastModified: object.LastModified, Size: object.Size });
                                filesFound++;
                            }
                        }
                        continuationToken = response.NextContinuationToken;
                    } while (continuationToken);
                    root.lastFolder = folder;
                }
                foldersListed++;
                folderTime += unitMs;

                // Everything modified before this point is now listed: no later folder can hold it.
                const settledBefore = folderTime - FOLDER_SKEW_MS;
                const ready = held.filter((file) => lastModifiedMs(file) < settledBefore);
                if (ready.length > 0) {
                    held = held.filter((file) => lastModifiedMs(file) >= settledBefore);
                    return ready.sort(byLastModified);
                }
            }

            if (!cursor.complete) {
                cursor.complete = true;
                console.log(`📊 Listed ${foldersListed} folder(s), ${objectsSeen} object(s), ${filesFound} unprocessed log file(s)`);
                if (objectsSeen === 0) {
                    console.warn(`⚠️ No log objects in the folders since ${new Date(resume.startMs).toISOString()} — check model invocation logging is still enabled and delivering to s3://${LOGS_BUCKET_NAME}/${LOGS_PREFIX}`);
                }
            }
            if (held.length === 0) return null;
            const rest = held.sort(byLastModified);
            held = [];
            return rest;
        }
    };
    return cursor;
}

/**
 * The fallback for a prefix that is not laid out in dated folders: one full listing,
 * holding only the unprocessed files (not every object) and stopping at the time
 * budget. Files can only be ordered once the listing is complete, so a listing the
 * budget cuts short processes nothing — and says so — rather than checkpointing out of
 * order.
 */
function openFullListingCursor(resume, timeLeft) {
    let consumed = false;
    const cursor = {
        complete: false,
        buffered: () => 0,
        async next() {
            if (consumed) return null;
            consumed = true;

            // Name the exact location being read: a wrong LOGS_PREFIX is the single most
            // common reason discovery finds nothing, and it is invisible from counts alone.
            console.log(`🪣 Listing s3://${LOGS_BUCKET_NAME}/${LOGS_PREFIX} in full (no dated folders found) for .gz logs newer than ${new Date(resume.startMs).toISOString()}`);
            const unprocessed = [];
            let objects = 0, logFiles = 0, bodyObjects = 0, pages = 0;
            let newest = null;
            const sample = [];
            let continuationToken;
            do {
                if (outOfTime(timeLeft)) {
                    console.warn(`⏱️ Time budget reached after listing ${objects} object(s) across ${pages} page(s) of s3://${LOGS_BUCKET_NAME}/${LOGS_PREFIX} — nothing is processed this run. This prefix is too large to list without Bedrock's dated folders; point LogsPrefix at the folder Bedrock delivers to (…/AWSLogs/).`);
                    return null;
                }
                const response = await listPage(LOGS_PREFIX, continuationToken);
                for (const object of response.Contents || []) {
                    objects++;
                    if (sample.length < 3) sample.push(object.Key);
                    if (object.Key.endsWith('.gz') && isBodyObject(object.Key)) bodyObjects++;
                    if (!isLogFile(object)) continue;
                    logFiles++;
                    if (!newest || lastModifiedMs(object) > lastModifiedMs(newest)) newest = object;
                    if (isUnprocessed(object, resume)) unprocessed.push({ Key: object.Key, LastModified: object.LastModified, Size: object.Size });
                }
                continuationToken = response.NextContinuationToken;
                pages++;
            } while (continuationToken);
            cursor.complete = true;

            unprocessed.sort(byLastModified);
            console.log(`📊 ${objects} object(s) across ${pages} page(s), ${logFiles} .gz log file(s), ${unprocessed.length} newer than checkpoint`);
            if (bodyObjects > 0) {
                console.log(`📦 ${bodyObjects} large-payload body object(s) under data/ skipped in the listing — they are fetched via inputBodyS3Path by the entries that own them`);
            }
            // Turn each "nothing to do" case into a specific, actionable reason.
            if (objects === 0) {
                console.warn(`⚠️ Nothing at s3://${LOGS_BUCKET_NAME}/${LOGS_PREFIX} — check LOGS_PREFIX matches where Bedrock actually delivers, and that model invocation logging is enabled for this account/region`);
            } else if (logFiles === 0) {
                console.warn(`⚠️ Objects exist under the prefix but none are .gz Bedrock logs. First key(s): ${sample.join(', ')} — LOGS_PREFIX may be pointing at the wrong level`);
            } else if (unprocessed.length === 0) {
                console.log(`✅ Up to date — newest log file is ${newest.Key} (${new Date(newest.LastModified).toISOString()}), at or before the checkpoint`);
            } else {
                console.log(`📄 Oldest unprocessed: ${unprocessed[0].Key} (${new Date(unprocessed[0].LastModified).toISOString()})`);
            }
            return unprocessed.length > 0 ? unprocessed : null;
        }
    };
    return cursor;
}

/**
 * Downloads, gunzips, and extracts AKTO messages from every log entry in one S3 object.
 * `discoveredAgents` is passed through so a first-seen SERVICE_AGENT caller (no ListAgents-
 * style API exists to discover those upfront) gets its one-time discovery message the
 * moment its first log entry is read, and is recorded so it isn't sent again.
 *
 * The object is decompressed and split into lines as it streams in, so memory holds one
 * log entry at a time rather than the compressed file, the whole decompressed text and
 * an array of its lines together.
 */
async function processLogFile(bucket, key, discoveredAgents) {
    const s3Object = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

    const messages = [];
    let entries = 0;
    const processLine = async (line) => {
        if (!line.trim()) return;
        entries++;
        try {
            messages.push(...await processBedrockLogEntry(JSON.parse(line), discoveredAgents));
        } catch (parseError) {
            logStats.unparseableLines++;
            console.warn(`⚠️ Skipping unparseable log line in ${key}: ${parseError.message}`);
        }
    };

    // The pipeline rejects on any stage's error — a truncated download or a corrupt
    // gzip fails the whole file, as reading it in one piece did, rather than yielding
    // whatever lines decoded before the damage.
    const decoder = new StringDecoder('utf8');
    let partial = '';
    await pipeline(s3Object.Body, createGunzip(), async (decompressed) => {
        for await (const chunk of decompressed) {
            const lines = (partial + decoder.write(chunk)).split('\n');
            partial = lines.pop();
            for (const line of lines) await processLine(line);
        }
        partial += decoder.end();
    });
    await processLine(partial);

    console.log(`✅ ${key}: ${entries} entries → ${messages.length} message(s)`);
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

module.exports = { openLogFileCursor, processLogFile, resetLogStats, getLogStats };
