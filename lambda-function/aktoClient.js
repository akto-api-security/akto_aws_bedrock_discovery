/**
 * Sends processed messages to AKTO's data ingestion API in bounded batches,
 * with a hard per-request timeout and retry-with-backoff on failure.
 */
const { DATA_INGESTION_ENDPOINT, AKTO_API_KEY, SEND_BATCH_SIZE, FETCH_TIMEOUT_MS, MAX_SEND_ATTEMPTS } = require('./config');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POSTs one batch with a hard timeout via AbortController, so a stuck connection
 * fails fast and loudly instead of silently eating the rest of the Lambda's time
 * budget until the platform kills the whole invocation.
 */
async function postWithTimeout(body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        console.log(`🌐 POST ${DATA_INGESTION_ENDPOINT} | Headers: Content-Type=application/json, X-API-KEY=[${AKTO_API_KEY.slice(0, 20)}...], User-Agent=AKTO-Bedrock-Monitor/3.0 | Body size: ${JSON.stringify(body).length} bytes`);
        const response = await fetch(DATA_INGESTION_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': AKTO_API_KEY, 'User-Agent': 'AKTO-Bedrock-Monitor/3.0' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        console.log(`📬 Response: ${response.status} ${response.statusText}`);
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
        }
        return response.json();
    } finally {
        clearTimeout(timer);
    }
}

/** Sends one batch, retrying up to MAX_SEND_ATTEMPTS times with linear backoff before giving up. */
async function sendBatchWithRetry(batch, batchNum, totalBatches) {
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt++) {
        try {
            const result = await postWithTimeout({ batchData: batch });
            console.log(`✅ Batch ${batchNum}/${totalBatches} sent (${batch.length} messages, attempt ${attempt})`);
            return result;
        } catch (error) {
            const isTimeout = error.name === 'AbortError';
            console.error(`❌ Batch ${batchNum}/${totalBatches} attempt ${attempt}/${MAX_SEND_ATTEMPTS} failed: ${isTimeout ? `timed out after ${FETCH_TIMEOUT_MS}ms` : error.message}`);
            if (attempt === MAX_SEND_ATTEMPTS) throw error;
            await sleep(1000 * attempt);
        }
    }
}

/** Splits messages into SEND_BATCH_SIZE chunks and sends them to AKTO sequentially. */
async function sendToDataIngestionService(messages) {
    if (messages.length === 0) return;
    const totalBatches = Math.ceil(messages.length / SEND_BATCH_SIZE);
    console.log(`📤 Sending ${messages.length} message(s) to AKTO in ${totalBatches} batch(es)`);
    for (let i = 0; i < messages.length; i += SEND_BATCH_SIZE) {
        const batchNum = Math.floor(i / SEND_BATCH_SIZE) + 1;
        await sendBatchWithRetry(messages.slice(i, i + SEND_BATCH_SIZE), batchNum, totalBatches);
    }
}

module.exports = { sendToDataIngestionService };
