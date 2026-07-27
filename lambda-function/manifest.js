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

/**
 * Writes the manifest back to S3. Never throws — a failed checkpoint write
 * shouldn't crash a run that already successfully sent data to AKTO. The
 * tradeoff is that chunk may get reprocessed next run, which is a safe
 * direction to fail in (possible duplicate) versus silently losing data.
 */
async function updateManifest(filesProcessed, discoveredAgents, lastProcessedTimestamp) {
    try {
        const manifest = {
            version: '2.2',
            lastProcessedTimestamp: lastProcessedTimestamp || new Date().toISOString(),
            filesProcessedCount: filesProcessed,
            lastManifestUpdate: new Date().toISOString(),
            discoveredAgents: discoveredAgents || {}
        };
        await s3Client.send(new PutObjectCommand({
            Bucket: MARKERS_BUCKET_NAME,
            Key: MANIFEST_KEY,
            Body: JSON.stringify(manifest, null, 2),
            ContentType: 'application/json'
        }));
        console.log(`✅ Manifest checkpointed: lastProcessedTimestamp=${manifest.lastProcessedTimestamp}, ${Object.keys(discoveredAgents || {}).length} known resources`);
    } catch (error) {
        console.error(`❌ Error checkpointing manifest: ${error.message}`);
    }
}

module.exports = { getManifest, updateManifest };
