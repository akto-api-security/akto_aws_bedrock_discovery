/**
 * The single place that knows AKTO's wire format for a mirrored HTTP message.
 */
const { AWS_REGION, AWS_ACCOUNT_ID } = require('./config');

/**
 * Builds one AKTO-format message, either from a real conversation pair
 * (isConversation=true) or from agent/harness discovery metadata (false).
 * Both shapes share the same envelope (headers/payload/tags/etc.) so this is
 * one function with two branches rather than two near-duplicate builders.
 */
function buildAgentMessage(data, isConversation) {
    const timestamp = isConversation ? Math.floor(new Date(data.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const originalHost = `bedrock-runtime.${AWS_REGION}.amazonaws.com`;

    const modelId = isConversation ? data.modelId : (data.foundationModel || 'unknown-model');
    const resourceId = isConversation ? data.agentId : (data.resourceType === 'HARNESS' ? data.harnessId : data.agentId);
    const resourceName = isConversation ? data.botName : (data.resourceType === 'HARNESS' ? data.harnessName : data.agentName);

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
        ? { message: data.userMessage, model: data.modelId, requestId: data.requestId }
        : {
            resourceId,
            resourceName,
            resourceType: data.resourceType,
            description: data.description || '',
            status: data.agentStatus,
            foundationModel: data.foundationModel,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            executionRoleArn: data.resourceType === 'HARNESS' ? data.executionRoleArn : data.agentResourceRoleArn
        };

    const responsePayload = isConversation ? { message: data.agentResponse, model: data.modelId } : {};

    const tags = {
        source: 'AWS_BEDROCK',
        'gen-ai': 'Gen AI',
        'account-id': isConversation ? (data.accountId || AWS_ACCOUNT_ID) : AWS_ACCOUNT_ID,
        region: isConversation ? (data.region || AWS_REGION) : AWS_REGION,
        agentType: isConversation
            ? (data.logType === 'AGENT' ? 'BEDROCK_AGENT' : (data.logType === 'HARNESS' ? 'AGENTCORE_AGENT' : 'UNKNOWN'))
            : (data.resourceType === 'HARNESS' ? 'AGENTCORE_AGENT' : 'BEDROCK_AGENT'),
        'bot-name': resourceName || '',
        'agent-id': (isConversation ? data.logType === 'AGENT' : data.resourceType === 'AGENT') ? (data.agentId || '') : '',
        'harness-id': (isConversation ? data.logType === 'HARNESS' : data.resourceType === 'HARNESS') ? (data.harnessId || '') : '',
        model: modelId,
        'bedrock-identity-arn': data.arn || '',
        ...(isConversation
            ? { operation: data.operation || 'Unknown', 'input-tokens': String(data.inputTokenCount || 0), 'output-tokens': String(data.outputTokenCount || 0), ...(data.logType === 'AGENT' ? data.agentTags : data.harnessTags) }
            : { 'discovery-type': 'METADATA_ONLY', 'has-conversations': 'false', ...(data.resourceType === 'AGENT' ? data.agentTags : data.harnessTags) })
    };

    return {
        path: `/model/${modelId}/invoke`,
        original_host: originalHost,
        method: 'POST',
        requestHeaders: JSON.stringify(requestHeaders),
        responseHeaders: JSON.stringify({ 'Content-Type': 'application/json', ...(isConversation && { 'X-Request-Id': data.requestId }) }),
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
        awsMetadata: JSON.stringify(isConversation ? (data.awsMetadata || {}) : { agentStatus: data.agentStatus, createdAt: data.createdAt, updatedAt: data.updatedAt })
    };
}

module.exports = { buildAgentMessage };
