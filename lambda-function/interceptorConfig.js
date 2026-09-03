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

// Used to tag live traffic the same way discovery tags the gateway, so both land on
// the same AKTO collection with the same identity.
const AWS_REGION = process.env.BEDROCK_AWS_REGION || process.env.AWS_REGION || '';
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID || '';

/**
 * gatewayId → gateway name, published by the attacher (gatewayInterceptor.js).
 * The interceptor resolves its own gateway ID from the Host header, but the name is
 * only obtainable from the control plane — and this function stays deliberately free
 * of the AWS SDK, so the attacher hands it over via the environment instead.
 * Absent or malformed, traffic is tagged with the gateway ID.
 */
function parseGatewayNameMap() {
    const raw = (process.env.GATEWAY_NAME_MAP || '').trim();
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        console.error('⚠️ GATEWAY_NAME_MAP is not valid JSON — traffic will be tagged with gateway IDs');
        return {};
    }
}

const GATEWAY_NAME_MAP = parseGatewayNameMap();

// Stripped before anything is shipped to AKTO — these carry the caller's
// credentials, and the guardrail decision never needs them.
const SENSITIVE_HEADERS = new Set([
    'authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-amz-security-token'
]);

module.exports = {
    HTTP_PROXY_ENDPOINT, AKTO_API_KEY, GUARDED_METHODS, GUARDRAIL_TIMEOUT_MS,
    AKTO_CONNECTOR, AKTO_ACCOUNT_ID, CONTEXT_SOURCE, INTERCEPTOR_OUTPUT_VERSION, SENSITIVE_HEADERS,
    AWS_REGION, AWS_ACCOUNT_ID, GATEWAY_NAME_MAP
};
