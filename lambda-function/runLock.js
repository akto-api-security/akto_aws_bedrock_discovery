/**
 * Single-flight guard for the discovery processor.
 *
 * Two things start a second copy of a run while the first is still going, and both
 * make every copy read the same checkpoint, process the same files and send the same
 * messages:
 *   - EventBridge fires every 10 minutes whether or not the previous run finished.
 *   - Lambda retries a failed asynchronous invocation (twice, a minute or two apart),
 *     reusing the original request ID.
 *
 * The lock is one small JSON object in the markers bucket, written with S3 conditional
 * writes (If-None-Match / If-Match), so two runs racing for it cannot both win. It
 * records who holds it and until when, plus the request IDs of recent runs — which is
 * how a retry recognises itself and exits.
 *
 * The lock never stops processing because of its own failure: any error other than
 * losing the race (permissions, an S3 endpoint without conditional writes, a parse
 * error) is logged and the run proceeds, exactly as it did before the lock existed.
 */
const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3Client, MARKERS_BUCKET_NAME, RUN_LOCK_KEY } = require('./config');

// Enough to cover every retry Lambda makes of one invocation, with room to spare.
const RECENT_REQUEST_IDS = 25;
// Held for the rest of the Lambda's life plus this, so a run killed mid-way frees the
// lock for the next scheduled run rather than holding it forever.
const EXPIRY_GRACE_MS = 60 * 1000;

/** The condition failed: another run wrote the lock between our read and our write. */
const isLostRace = (error) => {
    const status = error?.$metadata?.httpStatusCode;
    return status === 412 || status === 409 || error?.name === 'PreconditionFailed' || error?.name === 'ConditionalRequestConflict';
};

async function readLock() {
    try {
        const response = await s3Client.send(new GetObjectCommand({ Bucket: MARKERS_BUCKET_NAME, Key: RUN_LOCK_KEY }));
        const chunks = [];
        for await (const chunk of response.Body) chunks.push(chunk);
        return { lock: JSON.parse(Buffer.concat(chunks).toString('utf-8')), etag: response.ETag };
    } catch (error) {
        if (error.name === 'NoSuchKey') return { lock: null, etag: null };
        throw error;
    }
}

function writeLock(lock, etag) {
    return s3Client.send(new PutObjectCommand({
        Bucket: MARKERS_BUCKET_NAME,
        Key: RUN_LOCK_KEY,
        Body: JSON.stringify(lock, null, 2),
        ContentType: 'application/json',
        // Create only if absent, or replace only the exact version we read.
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: '*' })
    }));
}

const PROCEED_UNLOCKED = { acquired: true, release: async () => {} };

/**
 * Tries to take the lock for this run.
 *
 * Returns { acquired: true, release } to proceed — call release() when the run ends —
 * or { acquired: false, reason } when another run holds it or this invocation is a
 * retry of one that already ran.
 */
async function acquireRunLock(requestId, msLeft) {
    try {
        const { lock, etag } = await readLock();
        const now = Date.now();

        if (lock?.recentRequestIds?.includes(requestId)) {
            return { acquired: false, reason: `request ${requestId} already ran — this is a Lambda retry of it` };
        }
        if (lock && !lock.releasedAt && Date.parse(lock.expiresAt) > now) {
            return { acquired: false, reason: `run ${lock.holder} has held the lock since ${lock.acquiredAt} (until ${lock.expiresAt} at the latest)` };
        }
        if (lock && !lock.releasedAt) {
            console.warn(`⚠️ Previous run ${lock.holder} never released the lock (expired ${lock.expiresAt}) — it was most likely killed; taking over`);
        }

        const held = {
            holder: requestId,
            acquiredAt: new Date(now).toISOString(),
            expiresAt: new Date(now + msLeft + EXPIRY_GRACE_MS).toISOString(),
            recentRequestIds: [requestId, ...(lock?.recentRequestIds || [])].slice(0, RECENT_REQUEST_IDS)
        };
        const written = await writeLock(held, etag);

        return {
            acquired: true,
            async release() {
                try {
                    await writeLock({ ...held, releasedAt: new Date().toISOString() }, written.ETag);
                } catch (error) {
                    // Harmless: the lock expires on its own.
                    console.warn(`⚠️ Could not release the run lock (${error.message}) — it expires at ${held.expiresAt}`);
                }
            }
        };
    } catch (error) {
        if (isLostRace(error)) {
            return { acquired: false, reason: 'another run took the lock at the same moment' };
        }
        console.warn(`⚠️ Run lock unavailable (${error.name}: ${error.message}) — proceeding without overlap protection`);
        return PROCEED_UNLOCKED;
    }
}

module.exports = { acquireRunLock };
