/**
 * Configuration for the gateway interceptor Lambda (interceptor.js).
 *
 * Deliberately separate from config.js: that module constructs five AWS SDK
 * clients at import time, and the interceptor sits on the synchronous path of
 * every guarded tools/call — it must not pay for clients it never uses. Nothing
 * under interceptor*.js may require('./config').
 */

/**
 * AKTO's http-proxy lives at <origin>/api/http-proxy, but DATA_INGESTION_ENDPOINT
 * is the full ingest URL (e.g. https://akto.example.com:9095/api/ingestData), so
 * appending to it directly would produce /api/ingestData/api/http-proxy. Take the
 * origin and let AKTO_HTTP_PROXY_ENDPOINT override outright for deployments where
 * the proxy doesn't sit at the ingest host's root.
 */
function resolveHttpProxyEndpoint() {
    const override = (process.env.AKTO_HTTP_PROXY_ENDPOINT || '').trim();
    if (override) return override.replace(/\/+$/, '');

    const ingest = (process.env.DATA_INGESTION_ENDPOINT || '').trim();
    if (!ingest) {
        console.error('❌ DATA_INGESTION_ENDPOINT is not set — the interceptor will fail open on every call');
        return '';
    }
    try {
        return `${new URL(ingest).origin}/api/http-proxy`;
    } catch {
        console.error(`❌ DATA_INGESTION_ENDPOINT is not a valid URL: ${ingest} — interceptor will fail open`);
        return '';
    }
}

const HTTP_PROXY_ENDPOINT = resolveHttpProxyEndpoint();
const AKTO_API_KEY = process.env.AKTO_API_KEY || '';

// Which JSON-RPC methods get guardrailed. Everything else passes straight
// through untouched — initialize, tools/list, notifications, etc.
const GUARDED_METHODS = new Set(
    (process.env.GUARDED_METHODS || 'tools/call').split(',').map((m) => m.trim()).filter(Boolean)
);

// Must stay comfortably below the interceptor Lambda's own timeout (10s in the
// template) so a slow AKTO never turns into a Lambda timeout — a timeout here
// fails open, a Lambda timeout leaves the gateway waiting on nothing.
const GUARDRAIL_TIMEOUT_MS = Number(process.env.AKTO_GUARDRAIL_TIMEOUT_MS || 5000);

const AKTO_CONNECTOR = 'agentcore_gateway';
const AKTO_ACCOUNT_ID = process.env.AKTO_ACCOUNT_ID || '1000000';
const CONTEXT_SOURCE = 'AGENTIC';
const INTERCEPTOR_OUTPUT_VERSION = '1.0';

// Stripped before anything is shipped to AKTO — these carry the caller's
// credentials, and the guardrail decision never needs them.
const SENSITIVE_HEADERS = new Set([
    'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-amz-security-token'
]);

module.exports = {
    HTTP_PROXY_ENDPOINT, AKTO_API_KEY, GUARDED_METHODS, GUARDRAIL_TIMEOUT_MS,
    AKTO_CONNECTOR, AKTO_ACCOUNT_ID, CONTEXT_SOURCE, INTERCEPTOR_OUTPUT_VERSION, SENSITIVE_HEADERS
};
