/**
 * The single place that knows AKTO's wire format for a mirrored HTTP message.
 */
const { AWS_REGION, AWS_ACCOUNT_ID } = require('./config');
const { actorIp } = require('./identityActor');

/**
 * Maps a Bedrock log entry's operation to the real Runtime API path suffix it hit.
 * Falls back to 'invoke' for discovery (synthetic, not a real call) and any unrecognized operation.
 */
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
 * (isConversation=true) or from agent/harness discovery metadata (false).
 * Both shapes share the same envelope (headers/payload/tags/etc.) so this is
 * one function with two branches rather than two near-duplicate builders.
 */
function buildAgentMessage(data, isConversation) {
    const timestamp = isConversation ? Math.floor(new Date(data.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const originalHost = `bedrock-runtime.${AWS_REGION}.amazonaws.com`;

    const modelId = isConversation ? data.modelId : (data.foundationModel || 'unknown-model');
    const resourceId = isConversation
        ? data.agentId
        : (data.resourceType === 'HARNESS' ? data.harnessId : data.agentId);
    const resourceName = isConversation
        ? data.botName
        : (data.resourceType === 'HARNESS' ? data.harnessName : data.agentName);

    const requestHeaders = isConversation
        ? {
            'Content-Type': 'application/json',
            'X-Bedrock-Model-Id': modelId,
            'X-Request-Id': data.requestId,
            'bedrock-region': data.region || AWS_REGION,
            'bedrock-operation': data.operation || 'Unknown',
            'bedrock-identity-arn': data.arn || '',
            'aws-account-id': data.accountId || AWS_ACCOUNT_ID,
            ...(data.sessionId ? { 'bedrock-session-id': data.sessionId } : {}),
            host: originalHost
        }
        : {
            'Content-Type': 'application/json',
            'X-Bedrock-Model-Id': modelId,
            'bedrock-region': AWS_REGION,
            'bedrock-operation': 'DISCOVERY',
            'bedrock-identity-arn': data.arn || '',
            'aws-account-id': AWS_ACCOUNT_ID,
            host: originalHost
        };

    const requestPayload = isConversation
        ? {
            messages: [
                {
                    role: 'user',
                    content: data.userMessage
                }
            ]
        }
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

    const responsePayload = isConversation
        ? {
            output: {
                message: {
                    role: 'assistant',
                    content: [
                        {
                            text: data.agentResponse
                        }
                    ]
                }
            },
            usage: {
                inputTokens: data.inputTokenCount || 0,
                outputTokens: data.outputTokenCount || 0
            },
            awsMetadata: data.awsMetadata || {}
        }
        : { awsMetadata: { agentStatus: data.agentStatus, createdAt: data.createdAt, updatedAt: data.updatedAt } };

    const tags = {
        source: 'AWS_BEDROCK',
        'gen-ai': 'Gen AI',
        'account-id': isConversation ? (data.accountId || AWS_ACCOUNT_ID) : AWS_ACCOUNT_ID,
        region: isConversation ? (data.region || AWS_REGION) : AWS_REGION,
        // SERVICE_AGENT (a model invoked directly by an application or a person, with no
        // Bedrock Agent resource behind it) is deliberately tagged identically to a
        // real agent on the conversation (isConversation=true) side — same agentType,
        // same tag shape — so it surfaces on the AKTO dashboard as a genuine discovered
        // agent rather than a separate category. Its one-time discovery message
        // (buildServiceAgentDiscoveryMessage, discovery.js) already passes resourceType
        // 'AGENT' outright, so the discovery/false branch below never sees 'SERVICE_AGENT'
        // at all — logType 'SERVICE_AGENT' exists only so createStandardMessage knows to
        // skip the Bedrock Agent API calls that would fail for a caller with no such
        // resource; it never leaks into what's sent to AKTO.
        agentType: isConversation
            ? (data.logType === 'HARNESS' ? 'AGENTCORE_AGENT' : (data.logType === 'STANDALONE_RUNTIME' ? 'AGENTCORE_STANDALONE_RUNTIME' : (data.logType === 'AGENT' || data.logType === 'SERVICE_AGENT' ? 'BEDROCK_AGENT' : 'UNKNOWN')))
            : (data.resourceType === 'HARNESS' ? 'AGENTCORE_AGENT' : (data.resourceType === 'STANDALONE_RUNTIME' ? 'AGENTCORE_STANDALONE_RUNTIME' : 'BEDROCK_AGENT')),
        'bot-name': resourceName || '',
        // SERVICE_AGENT has no AWS resource ID of its own — the calling principal's name
        // (already in resourceId/resourceName) fills this slot instead, so a caller
        // still has a stable, non-empty identity tag to be grouped/deduped on.
        'agent-id': (isConversation ? data.logType === 'AGENT' || data.logType === 'STANDALONE_RUNTIME' || data.logType === 'SERVICE_AGENT' : data.resourceType === 'AGENT' || data.resourceType === 'STANDALONE_RUNTIME') ? (data.agentId || '') : '',
        'harness-id': (isConversation ? data.logType === 'HARNESS' : data.resourceType === 'HARNESS') ? (data.harnessId || '') : '',
        'runtime-id': (isConversation ? data.logType === 'STANDALONE_RUNTIME' : data.resourceType === 'STANDALONE_RUNTIME') ? (data.agentId || '') : '',
        model: modelId,
        'bedrock-identity-arn': data.arn || '',
        ...(isConversation
            ? {
                operation: data.operation || 'Unknown',
                'input-tokens': String(data.inputTokenCount || 0),
                'output-tokens': String(data.outputTokenCount || 0),
                // Bedrock emits no session identifier of its own, so a caller that
                // sets one in requestMetadata is the only source on this path.
                ...(data.sessionId ? { 'session-id': data.sessionId } : {}),
                // Every caller tag is forwarded under a prefix: these keys are chosen
                // by the customer's application and must not be able to overwrite the
                // tags this pipeline sets itself.
                ...Object.fromEntries(Object.entries(data.requestMetadata || {}).map(([k, v]) => [`request-metadata-${k}`, v])),
                // Only meaningful for direct model traffic: what kind of principal called.
                ...(data.logType === 'SERVICE_AGENT' ? { 'caller-kind': data.callerKind || 'UNKNOWN' } : {}),
                // SERVICE_AGENT's agentTags carries real execution-role/policy tags fetched
                // straight off IAM (discovery.js) — same tag names an AGENT gets, just
                // sourced without ever calling the (nonexistent-for-this-caller) Bedrock
                // Agent API.
                ...(data.logType === 'AGENT' || data.logType === 'SERVICE_AGENT' ? data.agentTags : data.harnessTags)
            }
            : { 'discovery-type': 'METADATA_ONLY', 'has-conversations': 'false', ...(data.resourceType === 'AGENT' ? data.agentTags : data.harnessTags) })
    };

    const path = `/model/${modelId}/${operationToPath(isConversation ? data.operation : null)}`;

    return {
        path,
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

module.exports = { buildAgentMessage, operationToPath };
