/**
 * Read-only AgentCore Gateway inspection: which gateways exist, what they look
 * like, and which harnesses call them.
 *
 * This is what replaces asking the client for gateway IDs — gatewayInterceptor.js
 * attaches to whatever this finds. Every function is best-effort and returns an
 * empty result rather than throwing, so a permissions gap or an unsupported
 * region degrades to "no gateways found" instead of failing the invocation.
 */
const {
    ListGatewaysCommand, GetGatewayCommand, ListGatewayTargetsCommand,
    GetGatewayTargetCommand, ListTagsForResourceCommand: BedrockCoreListTagsCommand
} = require('@aws-sdk/client-bedrock-agentcore-control');
const { ListAttachedRolePoliciesCommand } = require('@aws-sdk/client-iam');
const { bedrockAgentCoreControlClient, iamClient, AWS_REGION, AWS_ACCOUNT_ID } = require('./config');
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

/** The customer's own AWS tags on the gateway — same treatment agents and harnesses get. */
async function getGatewayTags(gatewayArn) {
    if (!gatewayArn) return {};
    try {
        return (await bedrockAgentCoreControlClient.send(new BedrockCoreListTagsCommand({ resourceArn: gatewayArn }))).tags || {};
    } catch (error) {
        console.error(`⚠️ Tag fetch failed for gateway ${gatewayArn}: ${error.message}`);
        return {};
    }
}

/**
 * Per-target detail — the backend this gateway actually fronts. The summary from
 * ListGatewayTargets omits the target configuration, which is where the backend
 * endpoint and credential provider live, so each target costs one GetGatewayTarget.
 */
async function getGatewayTargetDetail(gatewayId, targetId) {
    try {
        return await bedrockAgentCoreControlClient.send(new GetGatewayTargetCommand({
            gatewayIdentifier: gatewayId, targetId
        }));
    } catch (error) {
        console.error(`⚠️ GetGatewayTarget failed for ${gatewayId}/${targetId}: ${error.message}`);
        return null;
    }
}

/** Attached policy names on the gateway's execution role. Mirrors the agent/harness role enrichment. */
async function getGatewayRolePolicies(roleArn) {
    const roleName = roleArn ? String(roleArn).split('/').pop() : '';
    if (!roleName) return '';
    try {
        const response = await iamClient.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
        return (response.AttachedPolicies || []).map((p) => p.PolicyName).join(',');
    } catch (error) {
        console.error(`⚠️ Policy list failed for gateway role ${roleName}: ${error.message}`);
        return '';
    }
}

/** Host portion of a gateway URL — the value AKTO groups traffic by, so discovery must match live traffic. */
function gatewayHostFromUrl(gatewayUrl, gatewayId) {
    try {
        return new URL(gatewayUrl).host;
    } catch {
        // Synthesised from the documented URL shape when the gateway has no URL yet.
        return `${gatewayId}.gateway.bedrock-agentcore.${AWS_REGION}.amazonaws.com`;
    }
}

/**
 * Everything worth knowing about one gateway, flattened into tag-friendly strings —
 * the gateway equivalent of the metadata agents and harnesses already ship. Every
 * lookup is best-effort: a missing permission costs one attribute, not the profile.
 */
async function buildGatewayProfile(gateway, { harnessMap = {} } = {}) {
    const gatewayId = gateway.gatewayId;
    const host = gatewayHostFromUrl(gateway.gatewayUrl, gatewayId);

    const [awsTags, rolePolicies, targets] = await Promise.all([
        getGatewayTags(gateway.gatewayArn),
        getGatewayRolePolicies(gateway.roleArn),
        listGatewayTargets(gatewayId)
    ]);

    // Backend endpoints are the most security-relevant thing about a gateway: they
    // are where tool calls actually land.
    const targetDetails = [];
    for (const target of targets) {
        const detail = await getGatewayTargetDetail(gatewayId, target.targetId);
        const config = detail?.targetConfiguration?.mcp || {};
        const kind = Object.keys(config)[0] || Object.keys(detail?.targetConfiguration || {})[0] || 'unknown';
        targetDetails.push({
            name: detail?.name || target.name || target.targetId,
            id: target.targetId,
            status: detail?.status || target.status || '',
            kind,
            endpoint: config?.openApiSchema?.s3?.uri || config?.mcpServer?.endpoint || config?.lambda?.arn || '',
            credentialProvider: (detail?.credentialProviderConfigurations || [])
                .map((c) => c.credentialProviderType).filter(Boolean).join(',')
        });
    }

    const { arns: interceptorArns, points } = readAttachedInterceptors(gateway);
    const jwt = gateway.authorizerConfiguration?.customJWTAuthorizer || {};
    const callers = harnessMap[gatewayId] || [];

    // Only non-empty values are emitted, so a sparse gateway yields a sparse profile
    // rather than a wall of empty strings.
    const attributes = {
        'gateway-id': gatewayId,
        'gateway-arn': gateway.gatewayArn || '',
        'gateway-url': gateway.gatewayUrl || '',
        'gateway-status': String(gateway.status || ''),
        'gateway-protocol': gateway.protocolType || '',
        'gateway-role': gateway.roleArn || '',
        'gateway-role-policies': rolePolicies,
        'gateway-created-at': gateway.createdAt ? new Date(gateway.createdAt).toISOString() : '',
        'gateway-updated-at': gateway.updatedAt ? new Date(gateway.updatedAt).toISOString() : '',
        'auth-type': gateway.authorizerType || '',
        'auth-discovery-url': jwt.discoveryUrl || '',
        'auth-allowed-clients': (jwt.allowedClients || []).join(','),
        'kms-key': gateway.kmsKeyArn || '',
        'exception-level': gateway.exceptionLevel || '',
        'policy-engine': gateway.policyEngineConfiguration ? 'true' : '',
        waf: gateway.wafConfiguration?.webAclArn || gateway.webAclArn || '',
        'workload-identity': gateway.workloadIdentityDetails?.workloadIdentityArn || '',
        'mcp-instructions': gateway.protocolConfiguration?.mcp?.instructions ? 'set' : '',
        'mcp-search-type': gateway.protocolConfiguration?.mcp?.searchType || '',
        'interceptor-attached': interceptorArns.length ? 'true' : 'false',
        'interceptor-lambda-arns': interceptorArns.join(','),
        'interception-points': [...points].sort().join(','),
        targets: targetDetails.map((t) => t.name).join(','),
        'target-count': String(targetDetails.length),
        'target-kinds': [...new Set(targetDetails.map((t) => t.kind))].filter(Boolean).join(','),
        'target-endpoints': targetDetails.map((t) => t.endpoint).filter(Boolean).join(','),
        'target-credential-providers': [...new Set(targetDetails.flatMap((t) => t.credentialProvider.split(',')))].filter(Boolean).join(','),
        'called-by-harnesses': callers.map((c) => c.harnessName).join(','),
        'called-by-harness-ids': callers.map((c) => c.harnessId).join(',')
    };
    for (const [key, value] of Object.entries(attributes)) {
        if (value === '' || value === undefined || value === null) delete attributes[key];
    }

    return {
        gatewayId,
        gatewayArn: gateway.gatewayArn || '',
        name: gateway.name || gatewayId,
        host,
        url: gateway.gatewayUrl || '',
        status: String(gateway.status || ''),
        createdAt: gateway.createdAt ? new Date(gateway.createdAt).toISOString() : '',
        updatedAt: gateway.updatedAt ? new Date(gateway.updatedAt).toISOString() : '',
        roleArn: gateway.roleArn || '',
        region: AWS_REGION,
        accountId: AWS_ACCOUNT_ID,
        targets: targetDetails,
        callers,
        awsTags,
        attributes
    };
}

module.exports = {
    listAllGateways, getGatewayDetail, listGatewayTargets, buildHarnessGatewayMap,
    summarizeGateway, readAttachedInterceptors, extractGatewayIdFromArn,
    getGatewayTags, getGatewayTargetDetail, getGatewayRolePolicies,
    buildGatewayProfile, gatewayHostFromUrl
};
