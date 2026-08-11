/**
 * Sends processed messages to AKTO's data ingestion API in bounded batches,
 * with a hard per-request timeout, retry-with-backoff, and awareness of how much
 * time the invocation has left.
 *
 */
const {
    DATA_INGESTION_ENDPOINT, AKTO_API_KEY, SEND_BATCH_SIZE, MAX_BATCH_BYTES,
    SEND_DEADLINE_MARGIN_MS, FETCH_TIMEOUT_MS, MAX_SEND_ATTEMPTS
} = require('./config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Host only — enough to confirm which AKTO instance is being fed, without the path. */
function endpointHost() {
    try {
        return new URL(DATA_INGESTION_ENDPOINT).host;
    } catch {
        return String(DATA_INGESTION_ENDPOINT);
    }
}

/**
 * Groups messages into batches bounded by BOTH count and serialized size.
 *
 */
function buildBatches(messages) {
    const batches = [];
    let current = [];
    let currentBytes = 0;

    for (const message of messages) {
        const size = Buffer.byteLength(JSON.stringify(message), 'utf8');
        if (size > MAX_BATCH_BYTES) {
            if (current.length > 0) { batches.push(current); current = []; currentBytes = 0; }
            console.warn(`⚠️ Single message is ${(size / 1048576).toFixed(1)}MB, above the ${MAX_BATCH_BYTES / 1048576}MB batch cap — sending it alone`);
            batches.push([message]);
            continue;
        }
        if (current.length >= SEND_BATCH_SIZE || currentBytes + size > MAX_BATCH_BYTES) {
            batches.push(current);
            current = [];
            currentBytes = 0;
        }
        current.push(message);
        currentBytes += size;
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

/**
 * POSTs one batch with a hard timeout via AbortController, so a stuck connection
 * fails fast and loudly instead of silently eating the rest of the Lambda's time
 * budget until the platform kills the whole invocation.
 */
async function postWithTimeout(body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(DATA_INGESTION_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', authorization: AKTO_API_KEY, 'User-Agent': 'AKTO-Bedrock-Monitor/3.0' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
        }
        return response.json();
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Sends one batch, retrying up to MAX_SEND_ATTEMPTS times with linear backoff.
 * Each attempt's timeout is clamped to the time actually remaining, so the 25s
 * default can't overrun a 10s deadline.
 */
async function sendBatchWithRetry(batch, batchNum, totalBatches, timeLeft) {
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
        const remaining = timeLeft ? timeLeft() - SEND_DEADLINE_MARGIN_MS : FETCH_TIMEOUT_MS;
        const timeoutMs = Math.min(FETCH_TIMEOUT_MS, Math.max(1000, remaining));
        try {
            const result = await postWithTimeout({ batchData: batch }, timeoutMs);
            console.log(`✅ Batch ${batchNum}/${totalBatches} sent (${batch.length} message(s), attempt ${attempt})`);
            return result;
        } catch (error) {
            const isTimeout = error.name === 'AbortError';
            console.error(`❌ Batch ${batchNum}/${totalBatches} attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed: ${isTimeout ? `timed out after ${timeoutMs}ms` : error.message}`);
            if (attempt === MAX_SEND_ATTEMPTS) throw error;
            // Don't start a retry there isn't time to finish.
            if (timeLeft && timeLeft() < SEND_DEADLINE_MARGIN_MS) {
                throw new Error(`${error.message} (no time left to retry)`);
            }
            await sleep(1000 * attempt);
        }
    }
}

/**
 * Splits messages into batches and sends them to AKTO sequentially.
 *
 * Throws if any batch fails or the deadline is reached. The caller checkpoints only
 * after this resolves, so a partial delivery is never recorded as complete — the
 * affected files are simply reprocessed next run.
 */
async function sendToDataIngestionService(messages, timeLeft) {
    if (messages.length === 0) return;

    const batches = buildBatches(messages);
    const host = endpointHost();
    const startedAt = Date.now();
    console.log(`📤 Sending ${messages.length} message(s) to ${host} in ${batches.length} batch(es) of up to ${SEND_BATCH_SIZE}`);

    for (let i = 0; i < batches.length; i++) {
        if (timeLeft && timeLeft() < SEND_DEADLINE_MARGIN_MS) {
            // Stop before starting something that can't finish. Nothing is
            // checkpointed, so the remaining messages come back around next run.
            throw new Error(`Deadline reached after ${i}/${batches.length} batch(es) — ${timeLeft()}ms left, need ${SEND_DEADLINE_MARGIN_MS}ms. Remaining messages will be resent next run.`);
        }
        await sendBatchWithRetry(batches[i], i + 1, batches.length, timeLeft);
    }

    const elapsed = Date.now() - startedAt;
    console.log(`✅ All ${messages.length} message(s) accepted by ${host} in ${(elapsed / 1000).toFixed(1)}s (${Math.round(elapsed / messages.length)}ms/msg)`);
}

module.exports = { sendToDataIngestionService, buildBatches };
