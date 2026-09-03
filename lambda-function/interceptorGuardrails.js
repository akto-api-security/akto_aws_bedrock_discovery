/**
 * The AKTO guardrail call: POST the exchange to /api/http-proxy and turn the
 * verdict into allow / block / modify.
 *
 * Every failure mode here — network error, timeout, non-2xx, unparseable body —
 * is the caller's cue to fail open. A guardrail that can't be reached must never
 * take the client's gateway traffic down with it.
 */
const { HTTP_PROXY_ENDPOINT, AKTO_API_KEY, GUARDRAIL_TIMEOUT_MS, AKTO_CONNECTOR } = require('./interceptorConfig');

/**
 * Query flags tell AKTO which side of the exchange to evaluate. ingest_data is
 * only set on the request leg so one exchange isn't recorded twice.
 */
function buildHttpProxyUrl({ guardrails = false, responseGuardrails = false, ingestData = false } = {}) {
    const params = [];
    if (guardrails) params.push('guardrails=true');
    if (responseGuardrails) params.push('response_guardrails=true');
    params.push(`akto_connector=${AKTO_CONNECTOR}`);
    if (ingestData) params.push('ingest_data=true');
    return `${HTTP_PROXY_ENDPOINT}?${params.join('&')}`;
}

/** POSTs with a hard timeout via AbortController — same pattern as aktoClient.js. */
async function postJson(url, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GUARDRAIL_TIMEOUT_MS);
    const startedAt = Date.now();
    try {
        const headers = { 'Content-Type': 'application/json' };
        if (AKTO_API_KEY) headers.Authorization = AKTO_API_KEY;

        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal
        });
        const raw = await response.text();
        console.log(`Akto response: status=${response.status} duration=${Date.now() - startedAt}ms size=${raw.length}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`);
        try {
            return JSON.parse(raw);
        } catch {
            return raw;
        }
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Reads the verdict out of AKTO's envelope. Anything unexpected in the shape
 * degrades to "allowed" rather than guessing — a malformed verdict must not
 * silently become a block.
 */
function parseGuardrailsResult(result) {
    const data = result && typeof result === 'object' ? result.data : null;
    const gr = data && typeof data === 'object' ? data.guardrailsResult : null;
    if (!gr || typeof gr !== 'object') {
        return { allowed: true, reason: '', behaviour: '', modified: false, modifiedPayload: '' };
    }
    return {
        allowed: gr.Allowed === undefined ? true : gr.Allowed,
        reason: gr.Reason || '',
        behaviour: gr.behaviour || gr.Behaviour || '',
        modified: gr.Modified || false,
        modifiedPayload: gr.ModifiedPayload || ''
    };
}

/**
 * warn/alert policies are recorded centrally but deliberately don't block at the
 * gateway — that's how a policy gets rolled out in monitor mode before it's
 * switched to enforcing.
 */
function shouldBlock(allowed, behaviour) {
    if (allowed) return false;
    const b = String(behaviour || '').trim().toLowerCase();
    if (b === 'warn' || b === 'alert') {
        console.log(`Guardrail behaviour=${b} — allowing (logged only, no block at gateway)`);
        return false;
    }
    return true;
}

function blockMessage(reason, isResponse) {
    const subject = isResponse ? 'Tool result' : 'Tool request';
    return reason ? `${subject} blocked by Akto policy: ${reason}` : `${subject} blocked by Akto policy`;
}

/** ModifiedPayload arrives as either an object or a JSON string; null means unusable. */
function maybeParse(payload) {
    if (payload && typeof payload === 'object') return payload;
    if (typeof payload === 'string' && payload.trim()) {
        try {
            const parsed = JSON.parse(payload);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch {
            return null;
        }
    }
    return null;
}

module.exports = { buildHttpProxyUrl, postJson, parseGuardrailsResult, shouldBlock, blockMessage, maybeParse };
