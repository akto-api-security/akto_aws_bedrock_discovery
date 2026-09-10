/**
 * The S3-backed checkpoint for the AgentCore Harness/Runtime trace pipeline —
 * separate from manifest.js (the Bedrock Agent Classic / S3-logs checkpoint),
 * so the two pipelines never contend over the same file. Tracks
 * discoveredAgents (every Harness/Runtime seen so far, plus its
 * executionRoleArn for the role-identity map) and logGroupCheckpoints
 * (last-processed timestamp per CloudWatch log group — there's one per
 * AgentCore runtime).
 */
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { markersS3Client, MARKERS_BUCKET_NAME, TRACE_MANIFEST_KEY } = require('./config');

/** Reads the manifest from S3. Returns {discoveredAgents:{}, logGroupCheckpoints:{}} on first run or any read error — never null, never throws. */
async function getTraceManifest() {
    try {
        const response = await markersS3Client.send(new GetObjectCommand({ Bucket: MARKERS_BUCKET_NAME, Key: TRACE_MANIFEST_KEY }));
        const chunks = [];
        for await (const chunk of response.Body) chunks.push(chunk);
        const manifest = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        console.log(`📖 Trace manifest loaded: ${Object.keys(manifest.discoveredAgents || {}).length} known resource(s), ${Object.keys(manifest.logGroupCheckpoints || {}).length} known log group(s)`);
        return { discoveredAgents: {}, logGroupCheckpoints: {}, ...manifest };
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            console.log('📝 No trace manifest found — first run');
        } else {
            console.error(`⚠️ Error reading trace manifest, treating as first run: ${error.message}`);
        }
        return { discoveredAgents: {}, logGroupCheckpoints: {} };
    }
}

/**
 * Writes the manifest back to S3. Never throws — a failed checkpoint write
 * shouldn't crash a run that already successfully sent data to AKTO. The
 * tradeoff is that a batch may get reprocessed next run, which is a safe
 * direction to fail in (possible duplicate) versus silently losing data.
 */
async function updateTraceManifest(discoveredAgents, logGroupCheckpoints) {
    try {
        const manifest = {
            version: '1.0',
            lastManifestUpdate: new Date().toISOString(),
            discoveredAgents: discoveredAgents || {},
            logGroupCheckpoints: logGroupCheckpoints || {}
        };
        await markersS3Client.send(new PutObjectCommand({
            Bucket: MARKERS_BUCKET_NAME,
            Key: TRACE_MANIFEST_KEY,
            Body: JSON.stringify(manifest, null, 2),
            ContentType: 'application/json'
        }));
        console.log(`✅ Trace manifest checkpointed: ${Object.keys(manifest.discoveredAgents).length} known resource(s), ${Object.keys(manifest.logGroupCheckpoints).length} log group(s) tracked`);
    } catch (error) {
        console.error(`❌ Error checkpointing trace manifest: ${error.message}`);
    }
}

module.exports = { getTraceManifest, updateTraceManifest };
