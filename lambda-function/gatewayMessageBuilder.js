/**
 * AKTO wire format for an AgentCore Gateway discovery message.
 *
 * Deliberately parallel to messageBuilder.js / traceMessageBuilder.js so a gateway
 * lands in the inventory looking like the agents alongside it: same envelope, same
 * `source: AWS_BEDROCK`, same `bot-name`, same `discovery-type: METADATA_ONLY`.
 *
 * The one field that matters most is the host. AKTO groups traffic into collections
 * by host, and the interceptor's live traffic already reports the gateway's real URL
 * host — so discovery uses the same value, which is what makes the discovered gateway
 * and its subsequent tool traffic the same collection rather than two.
 */
const { AWS_REGION, AWS_ACCOUNT_ID } = require('./config');

const AGENT_TYPE = 'AGENTCORE_GATEWAY';
const AKTO_CONNECTOR = 'agentcore_gateway';

/**
 * Tags shared by the discovery message and the interceptor's live traffic. Keeping
 * them in one place is what stops the two drifting apart — if they disagree, AKTO
 * shows the same gateway twice.
 */
function buildGatewayTags({ gatewayId, gatewayName, region, accountId }) {
    return {
        source: 'AWS_BEDROCK',
        'mcp-server': 'MCP Server',
        service: AKTO_CONNECTOR,
        agentType: AGENT_TYPE,
        'bot-name': gatewayName || gatewayId || '',
        'gateway-id': gatewayId || '',
        'account-id': accountId || AWS_ACCOUNT_ID,
        region: region || AWS_REGION
    };
}

/** Builds the discovery message for one gateway profile (see gatewayDiscovery.buildGatewayProfile). */
function buildGatewayDiscoveryMessage(profile) {
    const timestamp = Math.floor(Date.now() / 1000);

    const requestHeaders = {
        'Content-Type': 'application/json',
        host: profile.host,
        'bedrock-region': profile.region,
        'bedrock-operation': 'DISCOVERY',
        'aws-account-id': profile.accountId,
        'gateway-id': profile.gatewayId,
        'gateway-name': profile.name
    };

    const requestPayload = {
        resourceId: profile.gatewayId,
        resourceName: profile.name,
        resourceType: 'GATEWAY',
        gatewayUrl: profile.url,
        protocol: profile.attributes['gateway-protocol'] || '',
        status: profile.status,
        authorizerType: profile.attributes['auth-type'] || '',
        roleArn: profile.roleArn,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
        // The backends this gateway fronts — the part a reviewer actually wants.
        targets: profile.targets.map((t) => ({
            name: t.name, id: t.id, status: t.status, kind: t.kind,
            endpoint: t.endpoint, credentialProvider: t.credentialProvider
        })),
        interceptors: {
            attached: profile.attributes['interceptor-attached'] === 'true',
            lambdaArns: (profile.attributes['interceptor-lambda-arns'] || '').split(',').filter(Boolean),
            interceptionPoints: (profile.attributes['interception-points'] || '').split(',').filter(Boolean)
        },
        calledBy: profile.callers.map((c) => ({ harnessId: c.harnessId, harnessName: c.harnessName }))
    };

    const responsePayload = {
        awsMetadata: {
            gatewayStatus: profile.status,
            createdAt: profile.createdAt,
            updatedAt: profile.updatedAt,
            targetCount: profile.targets.length
        }
    };

    const tags = {
        ...buildGatewayTags({
            gatewayId: profile.gatewayId,
            gatewayName: profile.name,
            region: profile.region,
            accountId: profile.accountId
        }),
        ...profile.attributes,
        'discovery-type': 'METADATA_ONLY',
        'has-conversations': 'false',
        // Customer tags last so they never overwrite our own keys.
        ...profile.awsTags
    };

    return {
        path: '/discovery',
        original_host: profile.host,
        method: 'POST',
        requestHeaders: JSON.stringify(requestHeaders),
        responseHeaders: JSON.stringify({ 'Content-Type': 'application/json' }),
        requestPayload: JSON.stringify(requestPayload),
        responsePayload: JSON.stringify(responsePayload),
        ip: '0.0.0.0',
        time: timestamp.toString(),
        statusCode: '200',
        type: 'HTTP',
        status: 'OK',
        akto_account_id: '1000000',
        akto_vxlan_id: '0',
        is_pending: 'false',
        source: 'MIRRORING',
        tag: JSON.stringify(tags),
        publishToGuardrails: true
    };
}

module.exports = { buildGatewayDiscoveryMessage, buildGatewayTags, AGENT_TYPE, AKTO_CONNECTOR };
