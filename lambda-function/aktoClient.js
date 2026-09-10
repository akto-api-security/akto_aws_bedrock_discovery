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
            const error = new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
            error.httpStatus = response.status;
            error.responseBody = text;
            throw error;
        }
        return response.json();
    } finally {
        clearTimeout(timer);
    }
}

/** The X-Request-Id of each message, so a rejection names the traffic it came from. */
function requestIdsOf(batch) {
    return batch.map((message) => {
        try {
            return JSON.parse(message.requestHeaders)['X-Request-Id'] || 'unknown';
        } catch {
            return 'unknown';
        }
    });
}

/**
 * Is this failure one that retrying could ever fix?
 *
 * Only asked after MAX_SEND_ATTEMPTS have already been spent. A payload the server
 * refuses on validation grounds will be refused identically forever, so the run must
 * set it aside and move on; anything else is treated as transient so the data is
 * retried on the next run rather than dropped.
 */
function isPermanentRejection(error) {
    const status = error.httpStatus;
    if (!status) return false;                       // timeout, DNS, connection reset
    if (status >= 400 && status < 500) {
        return status !== 408 && status !== 429;      // timeout / rate limit are transient
    }
    // A 5xx is normally transient, but the ingest API answers a too-large or malformed
    // payload with a 500 from its JSON layer — those cannot succeed on a retry.
    const body = String(error.responseBody || error.message || '');
    return /maximum allowed length|JSONException|exceeds maximum|too large|malformed/i.test(body);
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
            const bytes = Buffer.byteLength(JSON.stringify({ batchData: batch }), 'utf8');
            console.error(`❌ Batch ${batchNum}/${totalBatches} (${bytes}B, requestId ${requestIdsOf(batch).join(',')}) attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed: ${isTimeout ? `timed out after ${timeoutMs}ms` : error.message}`);
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
 * Returns {sent, quarantined[]} rather than throwing on a batch the server will never
 * accept.
 * throws for anything transient (timeout, 429, 503, connection reset) and for
 * the deadline, because that data SHOULD be retried.
 */
async function sendToDataIngestionService(messages, timeLeft) {
    if (messages.length === 0) return { sent: 0, quarantined: [] };

    const batches = buildBatches(messages);
    const host = endpointHost();
    const startedAt = Date.now();
    const quarantined = [];
    let sent = 0;
    console.log(`📤 Sending ${messages.length} message(s) to ${host} in ${batches.length} batch(es) of up to ${SEND_BATCH_SIZE}`);

    for (let i = 0; i < batches.length; i++) {
        if (timeLeft && timeLeft() < SEND_DEADLINE_MARGIN_MS) {
            // Stop before starting something that can't finish. Transient by nature —
            // the caller must not checkpoint past what is still unsent.
            const error = new Error(`Deadline reached after ${i}/${batches.length} batch(es) — ${timeLeft()}ms left, need ${SEND_DEADLINE_MARGIN_MS}ms. Remaining messages will be resent next run.`);
            error.sentBeforeFailure = sent;
            throw error;
        }
        try {
            await sendBatchWithRetry(batches[i], i + 1, batches.length, timeLeft);
            sent += batches[i].length;
        } catch (error) {
            if (!isPermanentRejection(error)) {
                // Retries are already spent, but this could succeed later. Fail the
                // flush so the caller leaves the checkpoint where it is.
                error.sentBeforeFailure = sent;
                throw error;
            }
            const bytes = Buffer.byteLength(JSON.stringify({ batchData: batches[i] }), 'utf8');
            for (const requestId of requestIdsOf(batches[i])) {
                quarantined.push({
                    requestId,
                    bytes,
                    status: error.httpStatus || 0,
                    reason: String(error.message).slice(0, 200),
                    at: new Date().toISOString()
                });
            }
            console.error(`🚫 Batch ${i + 1}/${batches.length} PERMANENTLY rejected after ${MAX_SEND_ATTEMPTS} attempt(s) — quarantining ${batches[i].length} message(s) (${bytes}B, requestId ${requestIdsOf(batches[i]).join(',')}) and continuing. Recorded in manifest.failedMessages.`);
        }
    }

    const elapsed = Date.now() - startedAt;
    if (quarantined.length > 0) {
        console.warn(`⚠️ ${sent} message(s) accepted by ${host}, ${quarantined.length} quarantined in ${(elapsed / 1000).toFixed(1)}s — quarantined messages are NOT retried, inspect manifest.failedMessages`);
    } else {
        console.log(`✅ All ${messages.length} message(s) accepted by ${host} in ${(elapsed / 1000).toFixed(1)}s (${Math.round(elapsed / Math.max(1, messages.length))}ms/msg)`);
    }
    return { sent, quarantined };
}

module.exports = { sendToDataIngestionService, buildBatches, isPermanentRejection, requestIdsOf };
