/**
 * AgentCore Gateway interceptor — real-time guardrails on MCP tool traffic.
 *
 * Its own Lambda (not the discovery function): the gateway invokes this
 * synchronously on every guarded call, so it runs lean and short-timeout while
 * discovery stays on 900s/1024MB. Attached to gateways automatically by
 * gatewayAttacher.js — nobody supplies gateway IDs by hand.
 *
 * The gateway calls this twice per tool invocation:
 *   REQUEST  — body only            → inspect args, may block or rewrite them
 *   RESPONSE — body + gatewayResponse → inspect the result, may block or rewrite it
 *
 * Fails open, always. Any error, timeout, or unreachable AKTO results in the
 * traffic passing through untouched: a guardrail outage must not become a
 * client outage.
 */
const { GUARDED_METHODS, HTTP_PROXY_ENDPOINT } = require('./interceptorConfig');
const { buildIngestPayload, cleanHeaders, isMcpBody } = require('./interceptorPayload');
const { buildHttpProxyUrl, postJson, parseGuardrailsResult, shouldBlock, blockMessage, maybeParse } = require('./interceptorGuardrails');
const { passthroughRequest, passthroughResponse, jsonrpcError } = require('./interceptorResponses');

/** REQUEST leg: guardrail the outgoing tools/call before the backend ever sees it. */
async function handleRequest(mcp) {
    const gatewayRequest = mcp.gatewayRequest || {};
    const body = gatewayRequest.body || {};
    const method = body.method || '';
    const requestId = body.id;

    if (!GUARDED_METHODS.has(method)) {
        console.log(`Pass-through (unguarded method): ${method || 'unknown'}`);
        return passthroughRequest(body);
    }

    if (!HTTP_PROXY_ENDPOINT) {
        console.warn('AKTO http-proxy endpoint not configured — fail-open pass-through');
        return passthroughRequest(body);
    }

    const toolName = (body.params || {}).name || 'unknown';
    console.log(`Guardrailing REQUEST tools/call: ${toolName}`);

    let verdict;
    try {
        const payload = buildIngestPayload({
            requestPayload: JSON.stringify(body),
            responsePayload: JSON.stringify({}),
            requestHeaders: cleanHeaders(gatewayRequest.headers),
            responseHeaders: {},
            statusCode: null,
            isMcp: isMcpBody(body)
        });
        // ingest_data only on this leg — the response leg would double-record the exchange.
        const result = await postJson(buildHttpProxyUrl({ guardrails: true, ingestData: true }), payload);
        verdict = parseGuardrailsResult(result);
    } catch (error) {
        console.error(`Akto guardrails error (REQUEST) — failing open: ${error.message}`);
        return passthroughRequest(body);
    }

    if (shouldBlock(verdict.allowed, verdict.behaviour)) {
        console.warn(`BLOCKING tools/call ${toolName}: ${verdict.reason}`);
        return jsonrpcError(requestId, blockMessage(verdict.reason, false));
    }

    if (verdict.modified && verdict.modifiedPayload) {
        const parsed = maybeParse(verdict.modifiedPayload);
        const newArgs = ((parsed || {}).params || {}).arguments;
        if (newArgs && typeof newArgs === 'object' && !Array.isArray(newArgs)) {
            console.log(`Applying guardrail-modified arguments for ${toolName}`);
            return passthroughRequest({ ...body, params: { ...(body.params || {}), arguments: newArgs } });
        }
        console.warn('Modified payload missing params.arguments — passing original through');
    }

    return passthroughRequest(body);
}

/** RESPONSE leg: guardrail the tool's result before it reaches the caller. */
async function handleResponse(mcp) {
    const gatewayRequest = mcp.gatewayRequest || {};
    const gatewayResponse = mcp.gatewayResponse || {};
    const reqBody = gatewayRequest.body || {};
    const respBody = gatewayResponse.body || {};
    const statusCode = gatewayResponse.statusCode === undefined ? 200 : gatewayResponse.statusCode;
    const requestId = respBody.id === undefined ? reqBody.id : respBody.id;
    const isStreaming = !!gatewayResponse.isStreamingResponse;

    if (!GUARDED_METHODS.has(reqBody.method)) {
        return passthroughResponse(respBody, statusCode);
    }

    // A 'method' key on the response side means this is a server-initiated
    // message (notification/request), not the tool's result — nothing to guard.
    if ('method' in respBody) {
        return passthroughResponse(respBody, statusCode);
    }

    if (!HTTP_PROXY_ENDPOINT) {
        console.warn('AKTO http-proxy endpoint not configured — fail-open pass-through');
        return passthroughResponse(respBody, statusCode);
    }

    const toolName = (reqBody.params || {}).name || 'unknown';
    console.log(`Guardrailing RESPONSE tools/call result: ${toolName} (streaming=${isStreaming})`);

    let verdict;
    try {
        const payload = buildIngestPayload({
            requestPayload: JSON.stringify(reqBody),
            responsePayload: JSON.stringify(respBody),
            requestHeaders: cleanHeaders(gatewayRequest.headers),
            responseHeaders: cleanHeaders(gatewayResponse.headers),
            statusCode,
            isMcp: isMcpBody(reqBody)
        });
        const result = await postJson(buildHttpProxyUrl({ responseGuardrails: true }), payload);
        verdict = parseGuardrailsResult(result);
    } catch (error) {
        console.error(`Akto guardrails error (RESPONSE) — failing open: ${error.message}`);
        return passthroughResponse(respBody, statusCode);
    }

    if (shouldBlock(verdict.allowed, verdict.behaviour)) {
        console.warn(`BLOCKING tools/call result ${toolName}: ${verdict.reason}`);
        // A streaming response has already committed its HTTP status to the
        // client, so the error rides inside a 200 body instead.
        return jsonrpcError(requestId, blockMessage(verdict.reason, true), isStreaming ? 200 : statusCode);
    }

    if (verdict.modified && verdict.modifiedPayload) {
        const parsed = maybeParse(verdict.modifiedPayload);
        if (parsed) {
            console.log(`Applying guardrail-modified result for ${toolName}`);
            const newBody = 'jsonrpc' in parsed
                ? parsed
                : { jsonrpc: '2.0', id: requestId, result: parsed.result === undefined ? parsed : parsed.result };
            return passthroughResponse(newBody, statusCode);
        }
        console.warn('Modified response payload not JSON — passing original through');
    }

    return passthroughResponse(respBody, statusCode);
}

/** Routes on the presence of gatewayResponse: absent → REQUEST leg, present → RESPONSE leg. */
async function handleInterceptorEvent(event) {
    const mcp = (event && event.mcp) || {};
    if (mcp.gatewayResponse !== undefined && mcp.gatewayResponse !== null) return handleResponse(mcp);
    return handleRequest(mcp);
}

exports.handler = async (event) => {
    try {
        return await handleInterceptorEvent(event);
    } catch (error) {
        // Last-resort net: even a bug in this file must not break the gateway.
        console.error(`❌ Interceptor fatal error — failing open: ${error.message}`);
        console.error(error.stack);
        const mcp = (event && event.mcp) || {};
        if (mcp.gatewayResponse !== undefined && mcp.gatewayResponse !== null) {
            const gr = mcp.gatewayResponse || {};
            return passthroughResponse(gr.body || {}, gr.statusCode === undefined ? 200 : gr.statusCode);
        }
        return passthroughRequest((mcp.gatewayRequest || {}).body || {});
    }
};

exports.handleInterceptorEvent = handleInterceptorEvent;
