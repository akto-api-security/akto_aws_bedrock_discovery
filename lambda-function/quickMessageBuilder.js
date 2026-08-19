/**
 * The single place that knows AKTO's wire format for an Amazon Quick Suite message —
 * the Quick counterpart of messageBuilder.js (Bedrock Agent Classic) and
 * traceMessageBuilder.js (AgentCore). Only QUICK_AGENT exists in this pipeline.
 *
 * `source` stays 'AWS_BEDROCK' deliberately, matching the other two builders: the AKTO
 * dashboard keys its Gen-AI categorisation off that value, and Quick traffic is
 * distinguished by agentType 'QUICK_SUITE_AGENT' instead — exactly how SERVICE_AGENT
 * and AGENTCORE_AGENT are already distinguished today. Change it in this one spot if
 * the ingestion side learns a dedicated Quick source.
 */
const { AWS_REGION, AWS_ACCOUNT_ID, QUICK_MODEL_ID } = require('./config');
const { summarizeResources } = require('./quickParser');

/** Drops empty tag values so the dashboard isn't littered with blank keys for fields this account doesn't deliver. */
function compact(tags) {
    const out = {};
    for (const [key, value] of Object.entries(tags)) {
        if (value === undefined || value === null || value === '') continue;
        out[key] = String(value);
    }
    return out;
}

/**
 * Builds one AKTO-format message, either from a real Quick chat exchange
 * (isConversation=true) or from Quick agent discovery metadata (false). Both shapes
 * share one envelope, so this is one function with two branches rather than two
 * near-duplicate builders.
 */
function buildQuickMessage(data, isConversation) {
    const timestamp = isConversation ? Math.floor(new Date(data.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const region = isConversation ? (data.region || AWS_REGION) : AWS_REGION;
    const accountId = isConversation ? (data.accountId || AWS_ACCOUNT_ID) : AWS_ACCOUNT_ID;
    // Quick Suite is served by the QuickSight control plane, so this is the real host
    // the traffic belongs to rather than a synthetic one.
    const originalHost = `quicksight.${region}.amazonaws.com`;

    const agentId = data.agentId || '';
    const resourceName = isConversation ? data.botName : data.agentName;

    const requestHeaders = {
        'Content-Type': 'application/json',
        'X-Bedrock-Model-Id': QUICK_MODEL_ID,
        'quick-agent-id': agentId,
        'agent-name': resourceName || '',
        'bedrock-region': region,
        'aws-account-id': accountId,
        'bedrock-operation': isConversation ? 'Chat' : 'DISCOVERY',
        'bedrock-identity-arn': data.userArn || data.arn || '',
        host: originalHost,
        ...(isConversation
            ? {
                'X-Request-Id': data.requestId || '',
                'quick-conversation-id': data.conversationId || '',
                'quick-user-arn': data.userArn || ''
            }
            : {})
    };

    const requestPayload = isConversation
        ? { messages: [{ role: 'user', content: [{ type: 'text', text: data.userMessage }] }] }
        : {
            resourceId: agentId,
            resourceName,
            resourceType: data.resourceType,
            description: data.description || '',
            status: data.agentStatus,
            lifecycle: data.agentLifecycle,
            creator: data.creator,
            foundationModel: QUICK_MODEL_ID,
            spaces: data.spaces || [],
            actionConnectors: data.actionConnectors || [],
            starterPrompts: data.starterPrompts || [],
            welcomeMessage: data.welcomeMessage || '',
            createdAt: data.createdAt,
            updatedAt: data.updatedAt
        };

    const responsePayload = isConversation
        ? {
            output: { message: { role: 'assistant', content: [{ text: data.agentResponse }] } },
            // Quick reports neither token count. Kept at zero so the field exists and
            // the shape matches the Bedrock pipeline rather than being absent.
            usage: { inputTokens: 0, outputTokens: 0 },
            awsMetadata: data.awsMetadata || {}
        }
        : {
            awsMetadata: {
                agentStatus: data.agentStatus,
                agentLifecycle: data.agentLifecycle,
                createdAt: data.createdAt,
                updatedAt: data.updatedAt,
                spaces: data.spaces || [],
                actionConnectors: data.actionConnectors || []
            }
        };

    const tags = compact({
        source: 'AWS_BEDROCK',
        'gen-ai': 'Gen AI',
        'account-id': accountId,
        region,
        agentType: 'QUICK_SUITE_AGENT',
        'bot-name': resourceName || '',
        'agent-id': agentId,
        model: QUICK_MODEL_ID,
        'bedrock-identity-arn': data.userArn || data.arn || '',

        ...(isConversation
            ? {
                operation: 'Chat',
                'input-tokens': '0',
                'output-tokens': '0',

                // Conversation/message correlation — quick-system-message-id is also the
                // join key to the FEEDBACK_LOGS log type, if that delivery is enabled.
                'quick-conversation-id': data.conversationId,
                'quick-user-message-id': data.userMessageId,
                'quick-system-message-id': data.systemMessageId,

                // Who asked. userRole/identityType/email/policies come from
                // DescribeUser + ListIAMPolicyAssignmentsForUser (quickDiscovery).
                'quick-user-arn': data.userArn,
                'quick-user-name': data.userName,
                'quick-user-type': data.userType,
                'quick-user-role': data.userRole,
                'quick-identity-type': data.identityType,
                'quick-user-email': data.userEmail,
                'quick-custom-permissions': data.customPermissions,
                'quick-namespace': data.namespace,

                // How it was asked, and how it went.
                'quick-status-code': data.statusCode,
                'quick-message-scope': data.messageScope,
                'quick-flow-id': data.flowId,
                'quick-surface-type': data.surfaceType,
                'quick-web-search': data.webSearch,
                'quick-latency-ms': data.latencyMs,
                'quick-ttft-ms': data.timeToFirstTokenMs,

                // What it touched.
                'quick-selected-resources': summarizeResources(data.selectedResources || []),
                'quick-cited-resources': summarizeResources(data.citedResources || []),
                'quick-cited-resource-count': String((data.citedResources || []).length),
                'quick-file-attachments': (data.fileAttachments || []).map((f) => f.name).filter(Boolean).join(','),
                'quick-file-count': String((data.fileAttachments || []).length),

                // The agent's tools, resolved to names/types via DescribeActionConnector.
                'quick-action-connectors': data.connectorNames,
                'quick-connector-types': data.connectorTypes,
                'quick-connector-count': String((data.actionConnectorIds || []).length),

                // Agent-level metadata, carried onto every conversation so a message is
                // self-describing without joining back to its discovery message.
                'quick-agent-status': data.agentStatus,
                'quick-agent-lifecycle': data.agentLifecycle,
                'quick-agent-creator': data.creator,
                'quick-spaces': (data.spaces || []).join(','),
                'quick-builtin-agent': data.isBuiltinAgent ? 'true' : '',

                // Quick agents have no execution role of their own, so these carry the
                // asking user's effective permissions instead. Same tag names the Bedrock
                // pipeline uses, so existing dashboard fields populate unchanged.
                'quick-iam-policies': data.iamPolicies,
                'bedrock-execution-role': data.executionRole,
                'bedrock-execution-role-arn': data.executionRoleArn,
                'bedrock-role-policies': data.rolePolicies,

                ...(data.agentTags || {})
            }
            : {
                'discovery-type': 'METADATA_ONLY',
                'has-conversations': 'false',
                'quick-agent-status': data.agentStatus,
                'quick-agent-lifecycle': data.agentLifecycle,
                'quick-agent-creator': data.creator,
                'quick-spaces': (data.spaces || []).join(','),
                'quick-action-connectors': data.connectorNames,
                'quick-connector-types': data.connectorTypes,
                'quick-builtin-agent': data.isBuiltinAgent ? 'true' : '',
                ...(data.agentTags || {})
            })
    });

    return {
        // Quick has no per-model route, so the path names the agent and the operation
        // that actually happened rather than borrowing Bedrock's /model/… shape.
        path: isConversation ? `/quick/agents/${agentId || 'unknown'}/chat` : `/quick/agents/${agentId || 'unknown'}/discovery`,
        original_host: originalHost,
        method: 'POST',
        requestHeaders: JSON.stringify(requestHeaders),
        responseHeaders: JSON.stringify({ 'Content-Type': 'application/json', ...(isConversation && { 'X-Request-Id': data.requestId || '' }) }),
        requestPayload: JSON.stringify(requestPayload),
        responsePayload: JSON.stringify(responsePayload),
        ip: '0.0.0.0',
        time: timestamp.toString(),
        // Quick's own status_code ('success', 'request_blocked', 'no_answer_found') is
        // reported as a tag rather than as an HTTP status: the delivery itself succeeded,
        // and rewriting it to 4xx would make blocked prompts look like transport failures.
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

module.exports = { buildQuickMessage };
