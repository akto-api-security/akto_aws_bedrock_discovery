/**
 * Pure functions that turn a raw Bedrock model-invocation log entry into
 * AKTO-shaped conversation pairs. No AWS calls, no shared state.
 */
const { AWS_REGION, AWS_ACCOUNT_ID } = require('./config');

/** AGENT (Bedrock Agents) vs HARNESS (AgentCore) vs UNKNOWN, based on the caller's IAM role ARN. */
function detectLogType(arn) {
    if (!arn) return 'UNKNOWN';
    if (arn.includes('BedrockAgents-')) return 'AGENT';
    if (arn.includes('AmazonBedrockAgentCoreHarnessDefaultServiceRole-')) return 'HARNESS';
    return 'UNKNOWN';
}

/** Pulls the Bedrock Agent ID out of a BedrockAgents-* execution role ARN. */
function extractAgentID(arn) {
    const match = arn?.match(/BedrockAgents-([A-Z0-9]+)-[a-f0-9-]+/);
    return match ? match[1] : '';
}

/** Pulls the AgentCore harness role suffix out of its default service-role ARN. */
function extractHarnessRoleSuffix(arn) {
    const match = arn?.match(/AmazonBedrockAgentCoreHarnessDefaultServiceRole-([a-z0-9]+)/);
    return match ? match[1] : '';
}

/** Pulls the IAM role name out of an assumed-role identity ARN (arn:aws:sts::ACCT:assumed-role/ROLE_NAME/session-id). */
function extractRoleNameFromAssumedRoleArn(arn) {
    const match = arn?.match(/assumed-role\/([^/]+)\//);
    return match ? match[1] : '';
}

/**
 * Resolves what actually called Bedrock for one log entry. Tries the
 * authoritative roleNameToResourceMap first — an exact match against a role
 * we've confirmed (via discovery.js's GetAgent/GetHarness/GetAgentRuntime) is
 * a real resource's execution role, which works regardless of whether that
 * role uses AWS's auto-generated default name or a customer-supplied custom
 * name. Falls back to the naming-convention regex only for roles the map
 * doesn't (yet) cover — not backfilled, or genuinely unattributed.
 */
function resolveLogIdentity(arn, roleNameToResourceMap) {
    const roleName = extractRoleNameFromAssumedRoleArn(arn);
    const match = roleName ? roleNameToResourceMap?.[roleName] : null;
    if (match) {
        return {
            logType: match.resourceType,
            agentId: match.resourceType === 'AGENT' ? match.resourceId : '',
            harnessId: match.resourceType === 'HARNESS' ? match.resourceId : '',
            harnessRoleSuffix: extractHarnessRoleSuffix(arn),
            runtimeId: match.resourceType === 'RUNTIME' ? match.resourceId : '',
            resourceName: match.resourceName || '',
            executionRoleArn: match.executionRoleArn || ''
        };
    }
    return {
        logType: detectLogType(arn),
        agentId: extractAgentID(arn),
        harnessId: '',
        harnessRoleSuffix: extractHarnessRoleSuffix(arn),
        runtimeId: '',
        resourceName: '',
        executionRoleArn: ''
    };
}

/** Pulls plain text out of a Bedrock content-block array (Nova/Claude shapes both use `{ text: ... }`). */
function extractTextFromContent(content) {
    if (!Array.isArray(content)) return '';
    const item = content.find((c) => c.text);
    return item ? item.text : '';
}

/** Strips <function_calls>/<function_results> blocks and unwraps <answer> tags; drops replies shorter than 10 chars. */
function cleanAgentResponse(rawResponse) {
    if (!rawResponse) return '';
    if (rawResponse.includes('<answer>') && rawResponse.includes('</answer>')) {
        const answer = rawResponse.substring(rawResponse.indexOf('<answer>') + 8, rawResponse.indexOf('</answer>')).trim();
        if (answer) return answer;
    }
    let cleaned = removeXMLTags(rawResponse, 'function_calls');
    cleaned = removeXMLTags(cleaned, 'function_results').trim();
    return cleaned.length >= 10 ? cleaned : '';
}

/** Removes a named XML tag and everything between its open/close pair. */
function removeXMLTags(text, tag) {
    return text.replace(new RegExp(`<${tag}>.*?</${tag}>`, 'gs'), '');
}

/**
 * Extracts every user/assistant conversation pair found in one log entry: the
 * final assistant response (from the output field) paired with the most recent
 * user message, plus any earlier user→assistant pairs from the message history.
 * roleNameToResourceMap is built in discovery.js from already-discovered resources'
 * real execution role ARNs — passed in as plain data so identity resolution here
 * stays a lookup, not an AWS call.
 */
function extractConversationPairs(logEntry, roleNameToResourceMap) {
    const pairs = [];
    try {
        let finalAssistantResponse = '';
        const outputMessage = logEntry.output?.outputBodyJson?.output?.message;
        if (outputMessage?.role === 'assistant' && outputMessage.content) {
            finalAssistantResponse = cleanAgentResponse(extractTextFromContent(outputMessage.content));
        }

        const messages = logEntry.input?.inputBodyJson?.messages || [];
        if (messages.length === 0) return pairs;

        const userMessages = messages
            .filter((m) => m.role === 'user')
            .map((m) => extractTextFromContent(m.content))
            .filter((text) => text && !text.includes('<function_results>') && text.trim().length > 0);

        const arn = logEntry.identity?.arn || '';
        const identity = resolveLogIdentity(arn, roleNameToResourceMap);
        const baseFields = {
            timestamp: logEntry.timestamp,
            requestId: logEntry.requestId,
            modelId: logEntry.modelId,
            agentId: identity.agentId,
            harnessId: identity.harnessId,
            harnessRoleSuffix: identity.harnessRoleSuffix,
            runtimeId: identity.runtimeId,
            resourceName: identity.resourceName,
            executionRoleArn: identity.executionRoleArn,
            arn,
            logType: identity.logType,
            operation: logEntry.operation || 'Unknown',
            accountId: logEntry.accountId || AWS_ACCOUNT_ID,
            region: logEntry.region || AWS_REGION,
            inputTokenCount: logEntry.input?.inputTokenCount || 0,
            outputTokenCount: logEntry.output?.outputTokenCount || 0
        };

        if (finalAssistantResponse && userMessages.length > 0) {
            pairs.push({ ...baseFields, userMessage: userMessages[userMessages.length - 1], agentResponse: finalAssistantResponse });
        }

        for (let i = 0; i < messages.length - 1; i++) {
            if (messages[i].role !== 'user' || messages[i + 1].role !== 'assistant') continue;
            const userText = extractTextFromContent(messages[i].content);
            if (!userText || userText.includes('<function_results>') || !userText.trim()) continue;
            const cleaned = cleanAgentResponse(extractTextFromContent(messages[i + 1].content));
            if (!cleaned) continue;
            if (pairs.some((p) => p.userMessage === userText && p.agentResponse === cleaned)) continue;
            pairs.push({ ...baseFields, userMessage: userText, agentResponse: cleaned });
        }
    } catch (error) {
        console.error(`❌ Error extracting conversation pairs: ${error.message}`);
    }
    return pairs;
}

/**
 * Extracts the tool-call execution trace for a conversation pair: looks for
 * toolUse blocks in the assistant message history first, falling back to the
 * output message when the model's stop reason is tool_use.
 */
function extractTraceData(logEntry, botName) {
    try {
        const messages = logEntry.input?.inputBodyJson?.messages || [];
        const stopReason = logEntry.output?.outputBodyJson?.stopReason;

        let toolCalls = messages
            .filter((m) => m.role === 'assistant')
            .flatMap((m) => (m.content || []).filter((item) => item.toolUse));

        if (toolCalls.length === 0 && stopReason === 'tool_use') {
            toolCalls = (logEntry.output?.outputBodyJson?.output?.message?.content || []).filter((item) => item.toolUse);
        }
        if (toolCalls.length === 0) return { executionFlow: [], toolsSummary: {} };

        const tools = new Set();
        const actions = new Set();
        const executionFlow = [{ step: 0, type: 'agent', name: botName, action: 'orchestrate', description: 'Agent orchestrating tool calls' }];

        toolCalls.forEach((item, i) => {
            const tool = item.toolUse?.name || 'unknown';
            const action = item.toolUse?.input?.action?.type || 'unknown';
            executionFlow.push({ step: i + 1, type: 'tool-call', tool, action, toolUseId: item.toolUse?.toolUseId || '' });
            tools.add(tool);
            actions.add(action);
        });

        return {
            executionFlow,
            toolsSummary: {
                agentOrchestrator: botName,
                tools: [...tools],
                actions: [...actions],
                totalToolCalls: toolCalls.length,
                executionPattern: `${botName}→${[...tools].join('→')}`
            }
        };
    } catch (error) {
        console.warn(`⚠️ Trace extraction failed: ${error.message}`);
        return { executionFlow: [], toolsSummary: {} };
    }
}

module.exports = {
    detectLogType, extractAgentID, extractHarnessRoleSuffix, extractTextFromContent,
    cleanAgentResponse, removeXMLTags, extractConversationPairs, extractTraceData
};
