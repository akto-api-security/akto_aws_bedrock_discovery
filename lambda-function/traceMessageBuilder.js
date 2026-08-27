/**
 * The single place that knows AKTO's wire format for a mirrored HTTP message.
 * Only HARNESS/RUNTIME resource types exist in this pipeline — Bedrock Agent
 * Classic isn't discovered or traced here (see lambda-function/ for that).
 */
const { AWS_REGION, AWS_ACCOUNT_ID } = require('./config');
const { actorIp } = require('./identityActor');

/** Normalizes discovery-message identity across HARNESS/RUNTIME, which use different field names for the same concept. */
function resolveDiscoveryIdentity(data) {
    if (data.resourceType === 'HARNESS') return { id: data.harnessId, name: data.harnessName, tags: data.harnessTags };
    return { id: data.runtimeId, name: data.runtimeName, tags: data.runtimeTags };
}

/** Maps a trace's operation to the real Runtime API path — falls back to /invoke for discovery (synthetic) and any unrecognized operation. */
function operationToPath(operation) {
    const paths = {
        Converse: 'converse',
        ConverseStream: 'converse-stream',
        InvokeModel: 'invoke',
        InvokeModelWithResponseStream: 'invoke-with-response-stream'
    };
    return paths[operation] || 'invoke';
}

/**
 * Builds one AKTO-format message, either from a real conversation pair
 * (isConversation=true) or from harness/runtime discovery metadata (false).
 */
function buildAgentMessage(data, isConversation) {
    const timestamp = isConversation ? Math.floor(new Date(data.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const originalHost = `bedrock-runtime.${AWS_REGION}.amazonaws.com`;

    const modelId = isConversation ? data.modelId : (data.foundationModel || 'unknown-model');
    const discoveryIdentity = isConversation ? null : resolveDiscoveryIdentity(data);
    const resourceId = isConversation ? (data.logType === 'HARNESS' ? data.harnessId : data.runtimeId) : discoveryIdentity.id;
    const resourceName = isConversation ? data.botName : discoveryIdentity.name;

    const requestHeaders = {
        'Content-Type': 'application/json',
        'X-Bedrock-Model-Id': modelId,
        'bedrock-agent-id': resourceId || '',
        'agent-name': resourceName || '',
        'bedrock-region': isConversation ? (data.region || AWS_REGION) : AWS_REGION,
        host: originalHost,
        'bedrock-operation': isConversation ? (data.operation || 'Unknown') : 'DISCOVERY',
        'bedrock-identity-arn': data.arn || '',
        'aws-account-id': isConversation ? (data.accountId || AWS_ACCOUNT_ID) : AWS_ACCOUNT_ID
    };
    if (isConversation) {
        requestHeaders['X-Request-Id'] = data.requestId;
        requestHeaders['bedrock-input-tokens'] = String(data.inputTokenCount || 0);
        requestHeaders['bedrock-output-tokens'] = String(data.outputTokenCount || 0);
    }

    const requestPayload = isConversation
        ? { messages: [{ role: 'user', content: [{ type: 'text', text: data.userMessage }] }] }
        : {
            resourceId,
            resourceName,
            resourceType: data.resourceType,
            description: data.description || '',
            status: data.agentStatus,
            foundationModel: data.foundationModel,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            executionRoleArn: data.executionRoleArn
        };

    const responsePayload = isConversation
        ? { response: data.agentResponse, awsMetadata: data.awsMetadata || {} }
        : { awsMetadata: { agentStatus: data.agentStatus, createdAt: data.createdAt, updatedAt: data.updatedAt } };

    const tags = {
        source: 'AWS_BEDROCK',
        'gen-ai': 'Gen AI',
        'account-id': isConversation ? (data.accountId || AWS_ACCOUNT_ID) : AWS_ACCOUNT_ID,
        region: isConversation ? (data.region || AWS_REGION) : AWS_REGION,
        agentType: (isConversation ? data.logType : data.resourceType) === 'HARNESS' ? 'AGENTCORE_AGENT' : 'AGENTCORE_RUNTIME',
        'bot-name': resourceName || '',
        'harness-id': (isConversation ? data.logType === 'HARNESS' : data.resourceType === 'HARNESS') ? (data.harnessId || '') : '',
        'runtime-id': (isConversation ? data.logType === 'RUNTIME' : data.resourceType === 'RUNTIME') ? (data.runtimeId || '') : '',
        model: modelId,
        'bedrock-identity-arn': data.arn || '',
        ...(isConversation
            ? { operation: data.operation || 'Unknown', 'input-tokens': String(data.inputTokenCount || 0), 'output-tokens': String(data.outputTokenCount || 0), ...(data.logType === 'HARNESS' ? data.harnessTags : data.runtimeTags) }
            : { 'discovery-type': 'METADATA_ONLY', 'has-conversations': 'false', ...(discoveryIdentity.tags || {}) })
    };

    return {
        path: `/model/${modelId}/${operationToPath(isConversation ? data.operation : null)}`,
        original_host: originalHost,
        method: 'POST',
        requestHeaders: JSON.stringify(requestHeaders),
        responseHeaders: JSON.stringify({ 'Content-Type': 'application/json', ...(isConversation && { 'X-Request-Id': data.requestId }) }),
        requestPayload: JSON.stringify(requestPayload),
        responsePayload: JSON.stringify(responsePayload),
        ip: actorIp(data.arn),
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

module.exports = { buildAgentMessage };
