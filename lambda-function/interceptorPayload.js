/**
 * Builds the AKTO http-proxy payload for one intercepted gateway exchange.
 *
 * The gateway speaks MCP over JSON-RPC, but AKTO's guardrail engine is fed the
 * same HTTP-shaped record as every other connector — so the JSON-RPC bodies go
 * in as requestPayload/responsePayload strings under a synthetic POST /mcp.
 */
const { STATUS_CODES } = require('http');
const { AKTO_CONNECTOR, AKTO_ACCOUNT_ID, CONTEXT_SOURCE, SENSITIVE_HEADERS } = require('./interceptorConfig');

/** True for a JSON-RPC 2.0 body — i.e. MCP traffic rather than a plain gen-AI call. */
function isMcpBody(body) {
    return !!body && typeof body === 'object' && String(body.jsonrpc || '') === '2.0';
}

/** Drops credential-bearing headers. Non-object input yields {} rather than throwing. */
function cleanHeaders(headers) {
    if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return {};
    const cleaned = {};
    for (const [key, value] of Object.entries(headers)) {
        if (typeof key === 'string' && !SENSITIVE_HEADERS.has(key.toLowerCase())) cleaned[key] = value;
    }
    return cleaned;
}

/**
 * AKTO groups traffic by host, so a record without one is unattributable. The
 * gateway doesn't always pass a Host header, hence this synthetic fallback —
 * split by traffic kind so MCP and gen-AI land in separate collections.
 */
function ensureHost(headers, isMcp) {
    if (Object.keys(headers).some((key) => key.toLowerCase() === 'host')) return headers;
    return { ...headers, host: `${AKTO_CONNECTOR}.${isMcp ? 'mcp' : 'ai-agent'}` };
}

/** First hop from the forwarding chain, or '' when the gateway didn't supply one. */
function clientIp(headers) {
    for (const key of ['X-Forwarded-For', 'x-forwarded-for', 'X-Real-Ip', 'x-real-ip']) {
        const value = headers[key];
        if (value) return String(value).split(',')[0].trim();
    }
    return '';
}

/** 'OK' for 200, etc. Unknown codes yield '' rather than throwing. */
function statusPhrase(code) {
    return STATUS_CODES[code] || '';
}

/** Tags drive which AKTO collection this shows up under. */
function buildTags(isMcp) {
    return isMcp
        ? { 'mcp-server': 'MCP Server', service: AKTO_CONNECTOR }
        : { 'gen-ai': 'Gen AI', service: AKTO_CONNECTOR };
}

function buildIngestPayload({ requestPayload, responsePayload, requestHeaders, responseHeaders, statusCode, isMcp }) {
    const tags = buildTags(isMcp);
    const code = statusCode === null || statusCode === undefined ? 200 : statusCode;
    const headers = ensureHost(requestHeaders, isMcp);
    return {
        path: '/mcp',
        requestHeaders: JSON.stringify(headers),
        responseHeaders: JSON.stringify(responseHeaders),
        method: 'POST',
        requestPayload,
        responsePayload,
        ip: clientIp(headers),
        time: String(Date.now()),
        statusCode: code,
        type: 'HTTP/1.1',
        status: statusPhrase(code),
        akto_account_id: AKTO_ACCOUNT_ID,
        akto_vxlan_id: 0,
        is_pending: 'false',
        source: 'MIRRORING',
        tag: JSON.stringify(tags),
        metadata: JSON.stringify(tags),
        contextSource: CONTEXT_SOURCE
    };
}

module.exports = { buildIngestPayload, buildTags, cleanHeaders, ensureHost, clientIp, statusPhrase, isMcpBody };
