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

async function updateManifest(filesProcessed, discoveredAgents, lastProcessedTimestamp, failedFiles = [], failedMessages = []) {
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

        // Same shape as failedFiles: newest first, deduped, capped. These are messages
        // AKTO refused permanently — they are never retried, so this is the only record
        // of them once the logs age out.
        const mergedRejects = [];
        const seenIds = new Set();
        for (const reject of [...failedMessages, ...(existing.failedMessages || [])]) {
            if (!reject?.requestId || seenIds.has(reject.requestId)) continue;
            seenIds.add(reject.requestId);
            mergedRejects.push(reject);
            if (mergedRejects.length >= MAX_FAILED_FILES) break;
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
            ...(mergedFailures.length > 0 && { failedFiles: mergedFailures }),
            ...(mergedRejects.length > 0 && { failedMessages: mergedRejects })
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
