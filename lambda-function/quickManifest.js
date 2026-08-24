/**
 * The S3-backed checkpoint for the Amazon Quick Suite chat-log pipeline —
 * separate from manifest.js (Bedrock Agent Classic) and traceManifest.js
 * (AgentCore), so no two pipelines ever contend over the same file.
 *
 * Holds four things beyond the file checkpoint, all of which exist to keep
 * QuickSight API calls out of the steady state:
 *   - discoveredAgents    every Quick agent seen so far (from ListAgents, plus the
 *                         built-in SYSTEM agent, which ListAgents never returns and
 *                         which is therefore discovered from the logs themselves)
 *   - actionConnectors    connector id → name/type/enabled actions. These are the
 *                         agent's tools; resolving one costs a DescribeActionConnector
 *                         call, and the set changes rarely, so it is cached across runs.
 *   - quickUsers          user ARN → Quick role, identity type and attached policies.
 *                         Same reasoning: DescribeUser +
 *                         ListIAMPolicyAssignmentsForUser per message would be brutal.
 *   - failedFiles         objects that could not be read, so a recurring bad file stays
 *                         visible after the CloudWatch logs age out.
 */
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, MARKERS_BUCKET_NAME, QUICK_MANIFEST_KEY } = require('./config');

const MAX_FAILED_FILES = 50;

const EMPTY = { discoveredAgents: {}, actionConnectors: {}, quickUsers: {}, lastProcessedTimestamp: null, failedFiles: [], failedMessages: [] };

/** Reads the manifest from S3. Returns the empty shape on first run or any read error — never null, never throws. */
async function getQuickManifest() {
    try {
        const response = await s3Client.send(new GetObjectCommand({ Bucket: MARKERS_BUCKET_NAME, Key: QUICK_MANIFEST_KEY }));
        const chunks = [];
        for await (const chunk of response.Body) chunks.push(chunk);
        const manifest = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        console.log(`📖 Quick manifest loaded: lastProcessedTimestamp=${manifest.lastProcessedTimestamp}, ${Object.keys(manifest.discoveredAgents || {}).length} known agent(s), ${Object.keys(manifest.actionConnectors || {}).length} known connector(s), ${Object.keys(manifest.quickUsers || {}).length} known user(s)`);
        return { ...EMPTY, ...manifest };
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            console.log('📝 No Quick manifest found — first run');
        } else {
            console.error(`⚠️ Error reading Quick manifest, treating as first run: ${error.message}`);
        }
        return { ...EMPTY };
    }
}

/**
 * Writes the manifest back to S3. Never throws — a failed checkpoint write shouldn't
 * crash a run that already delivered data to AKTO. The tradeoff is that a batch may be
 * reprocessed next run, which is the safe direction to fail in (possible duplicate)
 * versus silently losing data.
 */
async function updateQuickManifest({ discoveredAgents, actionConnectors, quickUsers, lastProcessedTimestamp, filesProcessed = 0, failedFiles = [], failedMessages = [] }) {
    try {
        const existing = await getQuickManifest();
        const previous = existing.lastProcessedTimestamp;

        // Same guard as the Bedrock manifest: never move the checkpoint backwards. If
        // two runs somehow overlap, the older one must not rewind past data the newer
        // one already consumed — that would re-send everything in between.
        let checkpoint = lastProcessedTimestamp || previous || null;
        if (previous && checkpoint && new Date(checkpoint) < new Date(previous)) {
            console.warn(`⚠️ Refusing to move the Quick checkpoint backwards (${checkpoint} < stored ${previous}) — another run likely wrote a newer position. Keeping ${previous}.`);
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

        // Same shape and capping as failedFiles: messages AKTO refused permanently. They
        // are never retried, so this is the only durable record that they were dropped —
        // the checkpoint has already moved past them by the time this is written.
        const mergedRejects = [];
        const seenIds = new Set();
        for (const reject of [...failedMessages, ...(existing.failedMessages || [])]) {
            if (!reject?.requestId || seenIds.has(reject.requestId)) continue;
            seenIds.add(reject.requestId);
            mergedRejects.push(reject);
            if (mergedRejects.length >= MAX_FAILED_FILES) break;
        }

        const manifest = {
            version: '1.1',
            lastProcessedTimestamp: checkpoint || new Date().toISOString(),
            lastManifestUpdate: new Date().toISOString(),
            filesProcessedCount: filesProcessed,
            agentCount: Object.keys(discoveredAgents || {}).length,
            discoveredAgents: discoveredAgents || {},
            actionConnectors: actionConnectors || {},
            quickUsers: quickUsers || {},
            ...(mergedFailures.length > 0 && { failedFiles: mergedFailures }),
            ...(mergedRejects.length > 0 && { failedMessages: mergedRejects })
        };
        await s3Client.send(new PutObjectCommand({
            Bucket: MARKERS_BUCKET_NAME,
            Key: QUICK_MANIFEST_KEY,
            Body: JSON.stringify(manifest, null, 2),
            ContentType: 'application/json'
        }));
        const moved = previous !== manifest.lastProcessedTimestamp;
        console.log(`✅ Quick manifest checkpointed: lastProcessedTimestamp=${manifest.lastProcessedTimestamp}${moved ? '' : ' (unchanged)'}, ${manifest.agentCount} known agent(s), ${Object.keys(manifest.actionConnectors).length} connector(s), ${Object.keys(manifest.quickUsers).length} user(s)${mergedFailures.length ? `, ${mergedFailures.length} failed file(s) recorded` : ''}${mergedRejects.length ? `, ${mergedRejects.length} rejected message(s) recorded` : ''}`);
    } catch (error) {
        console.error(`❌ Error checkpointing Quick manifest: ${error.message}`);
    }
}

module.exports = { getQuickManifest, updateQuickManifest };
