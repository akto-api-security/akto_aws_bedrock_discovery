/**
 * S3 checkpoint for gateway discovery: which gateways have been announced to AKTO,
 * and what they looked like at the time.
 *
 * Its own marker folder (akto/markers/agentcore-gateways/), like the S3-log and
 * trace pipelines, so gateway bookkeeping never contends with either checkpoint.
 *
 * The fingerprint is what keeps a 10-minute sweep from re-announcing the same
 * gateway forever while still catching real changes — a new target, a changed
 * authorizer, an interception point gained or lost.
 */
const crypto = require('crypto');
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, MARKERS_BUCKET_NAME, GATEWAY_MANIFEST_KEY } = require('./config');

/** Stable hash of the attributes we'd report — key order can't affect it. */
function fingerprintProfile(profile) {
    const material = JSON.stringify({
        name: profile.name,
        host: profile.host,
        status: profile.status,
        attributes: Object.fromEntries(Object.entries(profile.attributes || {}).sort(([a], [b]) => a.localeCompare(b))),
        awsTags: Object.fromEntries(Object.entries(profile.awsTags || {}).sort(([a], [b]) => a.localeCompare(b)))
    });
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

/** Reads the manifest. Returns an empty shape on first run or any read error — never throws. */
async function getGatewayManifest() {
    try {
        const response = await s3Client.send(new GetObjectCommand({ Bucket: MARKERS_BUCKET_NAME, Key: GATEWAY_MANIFEST_KEY }));
        const chunks = [];
        for await (const chunk of response.Body) chunks.push(chunk);
        const manifest = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        const known = Object.keys(manifest.discoveredGateways || {}).length;
        console.log(`📖 Gateway manifest loaded: ${known} gateway(s) already announced to AKTO`);
        return manifest;
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            console.log('📝 No gateway manifest found — first gateway discovery run');
        } else {
            console.error(`⚠️ Error reading gateway manifest, treating as first run: ${error.message}`);
        }
        return { discoveredGateways: {} };
    }
}

/**
 * Writes the manifest back. Never throws: a failed checkpoint must not undo an
 * attachment that already happened. The cost of failing here is one duplicate
 * discovery message next run, which is the safe direction.
 */
async function updateGatewayManifest(discoveredGateways) {
    try {
        const manifest = {
            version: '1.0',
            lastManifestUpdate: new Date().toISOString(),
            gatewayCount: Object.keys(discoveredGateways || {}).length,
            discoveredGateways: discoveredGateways || {}
        };
        await s3Client.send(new PutObjectCommand({
            Bucket: MARKERS_BUCKET_NAME,
            Key: GATEWAY_MANIFEST_KEY,
            Body: JSON.stringify(manifest, null, 2),
            ContentType: 'application/json'
        }));
        console.log(`✅ Gateway manifest checkpointed: ${manifest.gatewayCount} gateway(s) tracked`);
    } catch (error) {
        console.error(`❌ Error checkpointing gateway manifest: ${error.message}`);
    }
}

/**
 * Decides whether this gateway needs announcing: never seen, or its fingerprint
 * moved. Returns the reason too, so the log says why rather than just "sending".
 */
function needsAnnouncement(manifestEntry, fingerprint) {
    if (!manifestEntry) return { announce: true, reason: 'newly discovered' };
    if (manifestEntry.fingerprint !== fingerprint) {
        return { announce: true, reason: `configuration changed (${manifestEntry.fingerprint} → ${fingerprint})` };
    }
    return { announce: false, reason: 'unchanged since last announcement' };
}

/** The record persisted per gateway. */
function buildManifestEntry(profile, fingerprint, previous) {
    const now = new Date().toISOString();
    return {
        name: profile.name,
        gatewayArn: profile.gatewayArn,
        host: profile.host,
        url: profile.url,
        status: profile.status,
        interceptionPoints: (profile.attributes['interception-points'] || '').split(',').filter(Boolean),
        targetCount: profile.targets.length,
        fingerprint,
        firstDiscoveredAt: previous?.firstDiscoveredAt || now,
        lastAnnouncedAt: now
    };
}

module.exports = {
    getGatewayManifest, updateGatewayManifest, fingerprintProfile, needsAnnouncement, buildManifestEntry
};
