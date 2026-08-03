/**
 * The three response shapes an AgentCore gateway interceptor is allowed to
 * return. Every exit path in interceptor.js goes through one of these — the
 * gateway rejects anything else and fails the request outright, so these
 * shapes are contract, not convention.
 */
const { INTERCEPTOR_OUTPUT_VERSION } = require('./interceptorConfig');

/** Hands the request on to the gateway's backend, optionally with a modified body. */
function passthroughRequest(body) {
    return {
        interceptorOutputVersion: INTERCEPTOR_OUTPUT_VERSION,
        mcp: { transformedGatewayRequest: { body } }
    };
}

/** Hands the backend's response back to the caller, optionally modified. */
function passthroughResponse(body, statusCode) {
    return {
        interceptorOutputVersion: INTERCEPTOR_OUTPUT_VERSION,
        mcp: { transformedGatewayResponse: { body, statusCode } }
    };
}

/**
 * Replaces the exchange with a JSON-RPC error — this is how a block is
 * expressed. Note it's a transformedGatewayResponse even when blocking a
 * *request*: the request never reaches the backend, and the caller gets this
 * instead.
 */
function jsonrpcError(requestId, message, statusCode = 403) {
    return {
        interceptorOutputVersion: INTERCEPTOR_OUTPUT_VERSION,
        mcp: {
            transformedGatewayResponse: {
                statusCode,
                body: {
                    jsonrpc: '2.0',
                    id: requestId,
                    error: { code: -32000, message }
                }
            }
        }
    };
}

module.exports = { passthroughRequest, passthroughResponse, jsonrpcError };
