/**
 * Gateway identity derivation, shared by the interceptor (hot path) and the
 * attacher (control plane).
 *
 * Deliberately dependency-free — no AWS SDK, no config — because the interceptor
 * imports it and must stay lean. It also has to be the *same* code on both sides:
 * if the attacher and the interceptor derived names differently, a gateway's
 * discovery record and its live traffic would disagree on `bot-name`.
 */

// AgentCore gateway IDs are "<name>-<10 char suffix>", e.g.
//   akto-unified-test-gateway-1-ur3v24waoj -> akto-unified-test-gateway-1
const ID_SUFFIX = /-[a-z0-9]{10}$/i;

// The synthetic host interceptorPayload falls back to when a gateway sends no Host
// header. Never a real gateway, so it must not be mistaken for one.
const SYNTHETIC_HOST_LABEL = 'agentcore_gateway';

/**
 * Best-effort gateway name from its ID. This is what lets the published name map
 * carry only exceptions instead of one entry per gateway — so accounts with
 * hundreds of gateways don't run into Lambda's 4KB environment limit.
 *
 * Returns the ID unchanged when it doesn't look like name+suffix, which is the
 * safe direction: a slightly odd bot-name beats a wrong one.
 */
function deriveGatewayName(gatewayId) {
    if (!gatewayId) return '';
    const stripped = String(gatewayId).replace(ID_SUFFIX, '');
    // Refuse to strip everything (an ID that is *only* a suffix) or to return
    // something implausibly short.
    return stripped && stripped.length >= 3 ? stripped : String(gatewayId);
}

/**
 * Gateway ID from a Host header. AgentCore hosts look like
 *   <gatewayId>.gateway.bedrock-agentcore.<region>.amazonaws.com
 *
 * Two tiers on purpose. The strict form requires AWS's documented middle segment,
 * so nothing unrelated is ever mistaken for a gateway. The lenient fallback takes
 * the first DNS label if the strict form fails — which keeps identity working if
 * AWS changes its hostname format, instead of silently losing it forever.
 *
 * Only this Lambda's own gateways can invoke it (its resource policy allows the
 * AgentCore service principal and gateway roles alone), so a Host we don't
 * recognise is far more likely to be a new AWS format than an impostor.
 */
function extractGatewayIdFromHost(host) {
    const bare = String(host || '').split(':')[0].trim();
    if (!bare) return { gatewayId: '', confidence: 'none' };

    const strict = /^([^.]+)\.gateway\.bedrock-agentcore\./i.exec(bare);
    if (strict) return { gatewayId: strict[1], confidence: 'strict' };

    const firstLabel = bare.split('.')[0];
    if (!firstLabel || firstLabel.toLowerCase() === SYNTHETIC_HOST_LABEL) {
        return { gatewayId: '', confidence: 'none' };
    }
    // A single-label host (localhost) isn't a gateway hostname.
    if (!bare.includes('.')) return { gatewayId: '', confidence: 'none' };
    // Nor is an IP address — its first octet is not a gateway ID.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) return { gatewayId: '', confidence: 'none' };
    // Gateway IDs are DNS-ish; a purely numeric label is something else.
    if (/^\d+$/.test(firstLabel)) return { gatewayId: '', confidence: 'none' };

    return { gatewayId: firstLabel, confidence: 'lenient' };
}

module.exports = { deriveGatewayName, extractGatewayIdFromHost, SYNTHETIC_HOST_LABEL };
