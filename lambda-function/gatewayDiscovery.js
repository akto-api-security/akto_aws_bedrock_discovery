/**
 * Read-only AgentCore Gateway inspection: which gateways exist, what they look
 * like, and which harnesses call them.
 *
 * This is what replaces asking the client for gateway IDs — gatewayInterceptor.js
 * attaches to whatever this finds. Every function is best-effort and returns an
 * empty result rather than throwing, so a permissions gap or an unsupported
 * region degrades to "no gateways found" instead of failing the invocation.
 */
const { ListGatewaysCommand, GetGatewayCommand, ListGatewayTargetsCommand } = require('@aws-sdk/client-bedrock-agentcore-control');
const { bedrockAgentCoreControlClient } = require('./config');
const { listAllPages, listAllHarnesses, getHarnessMetadata } = require('./traceDiscovery');

const gatewayDetailCache = {};
const gatewayTargetsCache = {};

/** arn:aws:bedrock-agentcore:<region>:<acct>:gateway/<gatewayId> -> <gatewayId>. */
function extractGatewayIdFromArn(gatewayArn) {
    if (!gatewayArn) return '';
    return String(gatewayArn).split('/').pop();
}

/**
 * Lists every gateway in the region. Returns [] on failure — including the
 * common cases of AgentCore being unavailable in the region or the role
 * lacking bedrock-agentcore:ListGateways.
 */
async function listAllGateways() {
    try {
        return await listAllPages(
            (nextToken) => bedrockAgentCoreControlClient.send(new ListGatewaysCommand({ nextToken })),
            (response) => response.items
        );
    } catch (error) {
        console.error(`❌ ListGateways failed (no gateways will be processed): ${error.message}`);
        return [];
    }
}

/**
 * Full control-plane detail for one gateway. ListGateways' summaries omit
 * roleArn and interceptorConfigurations, both of which attachment needs, so
 * every gateway costs one GetGateway. Cached per invocation.
 */
async function getGatewayDetail(gatewayId, { useCache = true } = {}) {
    if (!gatewayId) return null;
    if (useCache && gatewayDetailCache[gatewayId]) return gatewayDetailCache[gatewayId];
    try {
        const detail = await bedrockAgentCoreControlClient.send(new GetGatewayCommand({ gatewayIdentifier: gatewayId }));
        gatewayDetailCache[gatewayId] = detail;
        return detail;
    } catch (error) {
        console.error(`⚠️ GetGateway failed for ${gatewayId}: ${error.message}`);
        return null;
    }
}

/** The backend MCP servers/tools a gateway fronts. Best-effort; [] on failure. */
async function listGatewayTargets(gatewayId) {
    if (!gatewayId) return [];
    if (gatewayTargetsCache[gatewayId]) return gatewayTargetsCache[gatewayId];
    try {
        const targets = await listAllPages(
            (nextToken) => bedrockAgentCoreControlClient.send(new ListGatewayTargetsCommand({ gatewayIdentifier: gatewayId, nextToken })),
            (response) => response.items
        );
        gatewayTargetsCache[gatewayId] = targets;
        return targets;
    } catch (error) {
        console.error(`⚠️ ListGatewayTargets failed for ${gatewayId}: ${error.message}`);
        return [];
    }
}

/**
 * Maps gatewayId -> the harnesses that call it, via
 * harness.tools[].config.agentCoreGateway.gatewayArn. This is the only reliable
 * control-plane link between an agent and a gateway.
 *
 * Used for logging and reporting, not for filtering: a gateway can also be
 * called by a standalone runtime or an external MCP client, neither of which
 * leaves a trace here, so absence from this map does not mean "unused".
 */
async function buildHarnessGatewayMap() {
    const map = {};
    try {
        const harnesses = await listAllHarnesses();
        for (const item of harnesses) {
            if (!item?.harnessId) continue;
            const harness = await getHarnessMetadata(item.harnessId);
            for (const tool of harness?.tools || []) {
                const gatewayArn = tool?.config?.agentCoreGateway?.gatewayArn;
                if (!gatewayArn) continue;
                const gatewayId = extractGatewayIdFromArn(gatewayArn);
                if (!map[gatewayId]) map[gatewayId] = [];
                map[gatewayId].push({ harnessId: item.harnessId, harnessName: harness?.name || item.harnessId });
            }
        }
    } catch (error) {
        console.error(`⚠️ Could not build harness→gateway map (attachment continues regardless): ${error.message}`);
    }
    return map;
}

/** Lambda ARNs of every interceptor currently attached, and the points they cover. */
function readAttachedInterceptors(gateway) {
    const arns = [];
    const points = new Set();
    for (const config of gateway?.interceptorConfigurations || []) {
        const arn = config?.interceptor?.lambda?.arn;
        if (arn) arns.push(arn);
        for (const point of config?.interceptionPoints || []) points.add(point);
    }
    return { arns, points };
}

/**
 * Flattens one gateway into tag-friendly string attributes — identity, URL,
 * protocol, inbound auth, attached interceptors, backend targets. Mirrors
 * _summarize_gateway in the Python handler so discovery messages can carry the
 * same fields, including whether the guardrail is actually wired up.
 */
async function summarizeGateway(gatewayArn) {
    const gatewayId = extractGatewayIdFromArn(gatewayArn);
    const gateway = await getGatewayDetail(gatewayId);
    if (!gateway) return {};

    const out = { id: gatewayId };
    if (gateway.name) out.name = gateway.name;
    if (gateway.gatewayUrl) out.url = gateway.gatewayUrl;
    if (gateway.status) out.status = String(gateway.status);
    if (gateway.protocolType) out.protocol = gateway.protocolType;
    if (gateway.roleArn) out.role = gateway.roleArn;
    if (gateway.authorizerType) out['auth-type'] = gateway.authorizerType;

    const jwt = gateway.authorizerConfiguration?.customJWTAuthorizer || {};
    if (jwt.discoveryUrl) out['auth-discovery-url'] = jwt.discoveryUrl;
    if (jwt.allowedClients?.length) out['auth-allowed-clients'] = jwt.allowedClients.join(',');

    const workloadIdentity = gateway.workloadIdentityDetails?.workloadIdentityArn;
    if (workloadIdentity) out['workload-identity'] = workloadIdentity;

    const { arns, points } = readAttachedInterceptors(gateway);
    out['interceptor-attached'] = arns.length ? 'true' : 'false';
    if (arns.length) out['interceptor-lambda-arns'] = arns.join(',');
    if (points.size) out['interception-points'] = [...points].sort().join(',');

    if (gateway.policyEngineConfiguration) out['policy-engine'] = 'true';

    const targets = await listGatewayTargets(gatewayId);
    if (targets.length) {
        out.targets = targets.map((t) => t.name || t.targetId || 'unknown').join(',');
        out['target-count'] = String(targets.length);
    }

    return out;
}

module.exports = {
    listAllGateways, getGatewayDetail, listGatewayTargets, buildHarnessGatewayMap,
    summarizeGateway, readAttachedInterceptors, extractGatewayIdFromArn
};
