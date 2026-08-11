/**
 * The S3-backed checkpoint: last processed log timestamp + the set of
 * agents/harnesses already discovered. Read at the start of every invocation,
 * written back incrementally as batches are successfully sent to AKTO.
 */
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, MARKERS_BUCKET_NAME, MANIFEST_KEY } = require('./config');

/** Reads the manifest from S3. Returns {} on first run or on any read error — never null, never throws. */
async function getManifest() {
    try {
        const response = await s3Client.send(new GetObjectCommand({ Bucket: MARKERS_BUCKET_NAME, Key: MANIFEST_KEY }));
        const chunks = [];
        for await (const chunk of response.Body) chunks.push(chunk);
        const manifest = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        console.log(`📖 Manifest loaded: lastProcessedTimestamp=${manifest.lastProcessedTimestamp}`);
        return manifest;
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            console.log('📝 No manifest found — first run');
        } else {
            console.error(`⚠️ Error reading manifest, treating as first run: ${error.message}`);
        }
        return {};
    }
}


const MAX_FAILED_FILES = 50;

/**
 * roleName → the agents that use it, derived from discoveredAgents so the two can
 * never disagree.
 *
 * This is the lookup the log pipeline performs on every entry: a Bedrock log
 * carries the caller's role, not the agent. Having it in the manifest answers
 * "which agent owns this role?" — and, just as usefully, shows when one role is
 * shared by several agents, which is the case the log pipeline can't resolve
 * without a session-name hint.
 */
function buildRoleToAgentsIndex(discoveredAgents) {
    const index = {};
    for (const entry of Object.values(discoveredAgents || {})) {
        if (!entry?.roleName) continue;
        if (!index[entry.roleName]) index[entry.roleName] = [];
        index[entry.roleName].push({
            resourceId: entry.resourceId,
            resourceName: entry.resourceName,
            resourceType: entry.resourceType
        });
    }
    return index;
}

/**
 * Writes the manifest back to S3. Never throws — a failed checkpoint write
 * shouldn't crash a run that already successfully sent data to AKTO. The
 * tradeoff is that chunk may get reprocessed next run, which is a safe
 * direction to fail in (possible duplicate) versus silently losing data.
 *
 * The checkpoint is monotonic: it re-reads what's already stored and never
 * writes an older timestamp. Two runs can overlap (EventBridge fires on a timer,
 * regardless of whether the last run finished), and without this a slower run
 * finishing second would drag the checkpoint backwards and cause every file
 * between the two positions to be reprocessed.
 *
 * lastProcessedTimestamp is always the LastModified of a file we actually read —
 * never wall-clock time. Checkpointing to "now" would skip any file written
 * moments earlier but not yet listed.
 */
async function updateManifest(filesProcessed, discoveredAgents, lastProcessedTimestamp, failedFiles = []) {
    try {
        const existing = await getManifest();
        const previous = existing.lastProcessedTimestamp;

        let checkpoint = lastProcessedTimestamp || previous || null;
        if (previous && checkpoint && new Date(checkpoint) < new Date(previous)) {
            console.warn(`⚠️ Refusing to move the checkpoint backwards (${checkpoint} < stored ${previous}) — another run likely wrote a newer position. Keeping ${previous}.`);
            checkpoint = previous;
        }

        // Newest first, de-duplicated by key, capped — a recurring bad file stays
        // visible without the list growing without bound.
        const mergedFailures = [];
        const seenKeys = new Set();
        for (const failure of [...failedFiles, ...(existing.failedFiles || [])]) {
            if (!failure?.key || seenKeys.has(failure.key)) continue;
            seenKeys.add(failure.key);
            mergedFailures.push(failure);
            if (mergedFailures.length >= MAX_FAILED_FILES) break;
        }

        const roleToAgents = buildRoleToAgentsIndex(discoveredAgents);
        const ambiguous = Object.entries(roleToAgents).filter(([, agents]) => agents.length > 1);
        if (ambiguous.length > 0) {
            // The log pipeline can only resolve these via a session-name hint, so
            // surfacing them here explains any "cannot determine which agent" skips.
            console.warn(`⚠️ ${ambiguous.length} role(s) are shared by multiple agents: ${ambiguous.map(([r, a]) => `${r} → ${a.length}`).join(', ')}`);
        }

        const manifest = {
            version: '2.4',
            lastProcessedTimestamp: checkpoint || new Date().toISOString(),
            filesProcessedCount: filesProcessed,
            lastManifestUpdate: new Date().toISOString(),
            agentCount: Object.keys(discoveredAgents || {}).length,
            roleCount: Object.keys(roleToAgents).length,
            roleToAgents,
            discoveredAgents: discoveredAgents || {},
            ...(mergedFailures.length > 0 && { failedFiles: mergedFailures })
        };
        await s3Client.send(new PutObjectCommand({
            Bucket: MARKERS_BUCKET_NAME,
            Key: MANIFEST_KEY,
            Body: JSON.stringify(manifest, null, 2),
            ContentType: 'application/json'
        }));
        const moved = previous !== manifest.lastProcessedTimestamp;
        console.log(`✅ Manifest checkpointed: lastProcessedTimestamp=${manifest.lastProcessedTimestamp}${moved ? '' : ' (unchanged)'}, ${Object.keys(discoveredAgents || {}).length} known resources${mergedFailures.length ? `, ${mergedFailures.length} failed file(s) recorded` : ''}`);
    } catch (error) {
        console.error(`❌ Error checkpointing manifest: ${error.message}`);
    }
}

module.exports = { getManifest, updateManifest, buildRoleToAgentsIndex };
