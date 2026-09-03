/**
 * Builds the AKTO http-proxy payload for one intercepted gateway exchange.
 *
 * The gateway speaks MCP over JSON-RPC, but AKTO's guardrail engine is fed the
 * same HTTP-shaped record as every other connector — so the JSON-RPC bodies go
 * in as requestPayload/responsePayload strings under a synthetic POST /mcp.
 */
const { STATUS_CODES } = require('http');
const {
    AKTO_CONNECTOR, AKTO_ACCOUNT_ID, CONTEXT_SOURCE, SENSITIVE_HEADERS,
    AWS_REGION, AWS_ACCOUNT_ID, GATEWAY_NAME_MAP
} = require('./interceptorConfig');
const { deriveGatewayName, extractGatewayIdFromHost } = require('./gatewayNaming');

/**
 * Resolves which gateway this call came through, from the Host header.
 *
 * Name resolution is three-tier, cheapest and most reliable first:
 *   1. the map the attacher published — authoritative, but only carries exceptions
 *   2. derived from the gateway ID — correct for the standard "<name>-<suffix>" form,
 *      which is why the map stays tiny regardless of how many gateways exist
 *   3. the raw ID — never empty, never wrong-looking
 *
 * Note that the AKTO collection does NOT depend on any of this: the Host header is
 * forwarded verbatim and AKTO groups by it. If AWS changes its hostname format, the
 * worst case is thinner tags, not misgrouped or unguarded traffic.
 */
function resolveGatewayIdentity(headers) {
    const hostKey = Object.keys(headers || {}).find((k) => k.toLowerCase() === 'host');
    const host = hostKey ? String(headers[hostKey]).split(':')[0] : '';
    const { gatewayId, confidence } = extractGatewayIdFromHost(host);
    if (!gatewayId) return { host, gatewayId: '', gatewayName: '', confidence };
    return {
        host,
        gatewayId,
        gatewayName: GATEWAY_NAME_MAP[gatewayId] || deriveGatewayName(gatewayId),
        confidence
    };
}

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

/**
 * Tags for a live call. The identity half (source / agentType / bot-name / gateway-id)
 * mirrors what gatewayMessageBuilder.js puts on the discovery message, so the gateway
 * AKTO discovered and the traffic flowing through it are recognisably the same thing.
 */
function buildTags(isMcp, identity = {}) {
    const kind = isMcp ? { 'mcp-server': 'MCP Server' } : { 'gen-ai': 'Gen AI' };
    const tags = {
        source: 'AWS_BEDROCK',
        ...kind,
        service: AKTO_CONNECTOR,
        agentType: 'AGENTCORE_GATEWAY',
        'bot-name': identity.gatewayName || identity.gatewayId || '',
        'gateway-id': identity.gatewayId || '',
        'account-id': AWS_ACCOUNT_ID,
        region: AWS_REGION
    };
    for (const [key, value] of Object.entries(tags)) {
        if (value === '') delete tags[key];
    }
    return tags;
}

function buildIngestPayload({ requestPayload, responsePayload, requestHeaders, responseHeaders, statusCode, isMcp }) {
    // Resolve before ensureHost, so identity comes from the gateway's real Host header
    // rather than the synthetic fallback.
    const identity = resolveGatewayIdentity(requestHeaders);
    const tags = buildTags(isMcp, identity);
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

module.exports = { buildIngestPayload, buildTags, cleanHeaders, ensureHost, clientIp, statusPhrase, isMcpBody, resolveGatewayIdentity };
