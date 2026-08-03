/**
 * Parses CloudWatch log records for one AgentCore trace into a conversation pair.
 * Records come in 4 shapes (see classifyRecord): SPAN, STRANDS_AGGREGATE
 * (whole-trace summary from the Strands tracer), GENAI_EVENT (per-message,
 * framework-agnostic), OTHER (discarded). All share one traceId, so identity
 * and content are resolved by merging across every record in the trace.
 */
const { AWS_REGION, AWS_ACCOUNT_ID } = require('./config');

/** Classifies one parsed CloudWatch Logs record by shape. */
function classifyRecord(record) {
    if (typeof record.traceId === 'string' && record.traceId
        && typeof record.spanId === 'string' && record.spanId
        && typeof record.name === 'string' && typeof record.startTimeUnixNano !== 'undefined') {
        return 'SPAN';
    }
    if (record.scope?.name === 'strands.telemetry.tracer' && (record.body?.input?.messages || record.body?.output?.messages)) {
        return 'STRANDS_AGGREGATE';
    }
    if (typeof record.eventName === 'string' && record.eventName.startsWith('gen_ai.')) {
        return 'GENAI_EVENT';
    }
    return 'OTHER';
}

/** Parses one CloudWatch log event's message as JSON, or null if unparseable. */
function parseLogRecord(logEvent) {
    try {
        return JSON.parse(logEvent.message);
    } catch {
        return null;
    }
}

/** Pulls the runtime ID out of its ARN. */
function extractRuntimeIdFromArn(arn) {
    const match = arn?.match(/:runtime\/([^/]+)\//);
    return match ? match[1] : '';
}

/** Pulls a harness's name out of its runtime's service.name ("harness_wb5n7.DEFAULT" -> "wb5n7"). */
function extractHarnessNameFromServiceName(serviceName) {
    const runtimeName = serviceName?.split('.')[0] || '';
    const match = runtimeName.match(/^harness_(.+)$/);
    return match ? match[1] : '';
}

/** Pulls identity fields off one record. */
function extractIdentityFromRecord(record) {
    const resourceAttrs = record.resource?.attributes || {};
    const attributes = record.attributes || {};
    const resourceArn = resourceAttrs['cloud.resource_id'] || '';
    return {
        traceId: record.traceId || '',
        spanId: record.spanId || '',
        resourceArn,
        runtimeId: extractRuntimeIdFromArn(resourceArn),
        harnessId: attributes['harness.id'] || '',
        serviceName: resourceAttrs['service.name'] || '',
        sessionId: attributes['session.id'] || attributes['gen_ai.conversation.id'] || resourceAttrs['session.id'] || '',
        modelId: attributes['gen_ai.request.model'] || attributes['gen_ai.response.model'] || '',
        startTimeUnixNano: record.startTimeUnixNano || record.timeUnixNano || null
    };
}

/** Merges identity fields across every record sharing one traceId — first non-empty value per field wins. */
function resolveTraceIdentity(records) {
    const merged = { traceId: '', spanId: '', resourceArn: '', runtimeId: '', harnessId: '', serviceName: '', sessionId: '', modelId: '', startTimeUnixNano: null };
    for (const record of records) {
        const identity = extractIdentityFromRecord(record);
        for (const key of Object.keys(merged)) {
            if (!merged[key] && identity[key]) merged[key] = identity[key];
        }
    }
    return merged;
}

/** Reads message text out of one input/output message object, across its several possible content shapes. */
function extractMessageText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((c) => c?.text || '').filter(Boolean).join(' ');
    if (content && typeof content === 'object') {
        if (typeof content.message === 'string') return content.message;
        if (typeof content.content === 'string') {
            try {
                const parsed = JSON.parse(content.content);
                if (Array.isArray(parsed)) return parsed.map((c) => c?.text || '').filter(Boolean).join(' ');
            } catch {
                return content.content;
            }
            return content.content;
        }
    }
    return '';
}

/** Extracts text out of a gen_ai event's content-block array. */
function extractTextFromContentBlocks(content) {
    if (!Array.isArray(content)) return '';
    return content.map((c) => c?.text || '').filter(Boolean).join(' ');
}

/** Extracts a conversation pair from a Strands whole-trace aggregate. */
function extractConversationContentFromStrandsAggregate(record) {
    const inputMessages = record.body?.input?.messages || [];
    const outputMessages = record.body?.output?.messages || [];
    const lastUser = [...inputMessages].reverse().find((m) => m.role === 'user');
    const lastAssistant = [...outputMessages].reverse().find((m) => m.role === 'assistant');
    return {
        userMessage: lastUser ? extractMessageText(lastUser) : '',
        agentResponse: lastAssistant ? extractMessageText(lastAssistant) : ''
    };
}

/** Framework-agnostic fallback: reconstructs a conversation pair from individual gen_ai.* events. */
function extractConversationContentFromGenAiEvents(records) {
    const userTexts = records.filter((r) => r.eventName === 'gen_ai.user.message').map((r) => extractTextFromContentBlocks(r.body?.content));
    const choiceTexts = records.filter((r) => r.eventName === 'gen_ai.choice').map((r) => extractTextFromContentBlocks(r.body?.message?.content));
    const assistantTexts = records.filter((r) => r.eventName === 'gen_ai.assistant.message').map((r) => extractTextFromContentBlocks(r.body?.content));
    return {
        userMessage: userTexts[userTexts.length - 1] || '',
        agentResponse: choiceTexts[choiceTexts.length - 1] || assistantTexts[assistantTexts.length - 1] || ''
    };
}

/** Only reliable userMessage source in a multi-round tool-using trace — generic gen_ai.user.message gets repurposed for tool-result feedback by later rounds. */
function extractUserMessageFromHarnessConversationEvent(records) {
    const event = records.find((r) => r.eventName === 'gen_ai.HarnessConversationRole.user.message');
    return event ? extractTextFromContentBlocks(event.body?.content) : '';
}

/** Resolves conversation content for one trace, preferring the most reliable source per field with fallbacks. */
function resolveTraceContent(records) {
    let userMessage = extractUserMessageFromHarnessConversationEvent(records);
    let agentResponse = '';

    const strandsAggregates = records.filter((r) => classifyRecord(r) === 'STRANDS_AGGREGATE');
    if (strandsAggregates.length > 0) {
        const fromAggregate = extractConversationContentFromStrandsAggregate(strandsAggregates[strandsAggregates.length - 1]);
        agentResponse = fromAggregate.agentResponse;
        if (!userMessage) userMessage = fromAggregate.userMessage;
    }

    if (!userMessage || !agentResponse) {
        const genAiEvents = records.filter((r) => classifyRecord(r) === 'GENAI_EVENT');
        if (genAiEvents.length > 0) {
            const fromEvents = extractConversationContentFromGenAiEvents(genAiEvents);
            if (!userMessage) userMessage = fromEvents.userMessage;
            if (!agentResponse) agentResponse = fromEvents.agentResponse;
        }
    }

    return { userMessage, agentResponse: stripThinkingBlock(agentResponse) };
}

/** Strips a leading <thinking>...</thinking> block so the dashboard shows a clean final answer, not raw reasoning. */
function stripThinkingBlock(text) {
    if (!text) return text;
    return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
}

/** Pulls an action-type label out of a tool call's input — checks the direct shape, then one level into every input key (AWS built-in tools nest it under a tool-specific wrapper key). */
function extractToolActionType(input) {
    if (!input || typeof input !== 'object') return 'unknown';
    if (input.action?.type) return input.action.type;
    for (const value of Object.values(input)) {
        if (value?.action?.type) return value.action.type;
    }
    return 'unknown';
}

/** Extracts the tool-call execution chain for one trace from its gen_ai.assistant.message/gen_ai.tool.message records. */
function extractAgentCoreExecutionFlow(records, botName) {
    const resultsByToolUseId = {};
    for (const record of records) {
        if (record.eventName !== 'gen_ai.tool.message') continue;
        const toolUseId = record.body?.id;
        if (toolUseId) resultsByToolUseId[toolUseId] = extractTextFromContentBlocks(record.body?.content);
    }

    const toolCalls = [];
    for (const record of records) {
        if (record.eventName !== 'gen_ai.assistant.message') continue;
        for (const block of record.body?.content || []) {
            if (block?.toolUse) toolCalls.push(block.toolUse);
        }
    }
    if (toolCalls.length === 0) return { executionFlow: [], toolsSummary: {} };

    const tools = new Set();
    const actions = new Set();
    const executionFlow = [{ step: 0, type: 'agent', name: botName, action: 'orchestrate', description: 'Agent orchestrating tool calls' }];

    toolCalls.forEach((toolUse, i) => {
        const tool = toolUse.name || 'unknown';
        const action = extractToolActionType(toolUse.input);
        executionFlow.push({ step: i + 1, type: 'tool-call', tool, action, toolUseId: toolUse.toolUseId || '', result: resultsByToolUseId[toolUse.toolUseId] || '' });
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
}

/**
 * Adapts one trace's resolved identity+content into the pair shape createStandardMessage
 * expects. Uses harnessNameToResourceMap (not roleNameToResourceMap) for Harness lookups
 * since a Harness and its auto-provisioned Runtime commonly share one execution role.
 */
function buildConversationPair(identity, content, logGroup, roleNameToResourceMap, harnessNameToResourceMap, records) {
    const runtimeId = identity.runtimeId || logGroup.runtimeId || '';
    let harnessId = identity.harnessId;
    let knownHarness = null;

    if (harnessNameToResourceMap) {
        if (harnessId) {
            knownHarness = Object.values(harnessNameToResourceMap).find((h) => h.resourceId === harnessId) || null;
        } else {
            const harnessName = extractHarnessNameFromServiceName(identity.serviceName);
            knownHarness = (harnessName && harnessNameToResourceMap[harnessName]) || null;
            if (knownHarness) harnessId = knownHarness.resourceId;
        }
    }

    let modelId = identity.modelId || knownHarness?.foundationModel;
    let logType = 'UNKNOWN';
    let resourceId = '';
    let resourceName = identity.serviceName || '';
    let executionRoleArn = '';

    if (harnessId) {
        logType = 'HARNESS';
        resourceId = harnessId;
        resourceName = knownHarness?.resourceName || resourceName;
        executionRoleArn = knownHarness?.executionRoleArn || '';
    } else if (runtimeId) {
        logType = 'RUNTIME';
        resourceId = runtimeId;
        const known = roleNameToResourceMap && Object.values(roleNameToResourceMap).find((r) => r.resourceType === 'RUNTIME' && r.resourceId === resourceId);
        resourceName = known?.resourceName || resourceName;
        executionRoleArn = known?.executionRoleArn || '';
        if (!modelId) modelId = known?.foundationModel;
    }

    return {
        timestamp: identity.startTimeUnixNano ? Math.floor(Number(identity.startTimeUnixNano) / 1e6) : Date.now(),
        requestId: identity.traceId || identity.spanId || '',
        modelId: modelId || 'unknown-model',
        harnessId: logType === 'HARNESS' ? resourceId : '',
        harnessRoleSuffix: '',
        runtimeId: logType === 'RUNTIME' ? resourceId : '',
        resourceName,
        executionRoleArn,
        arn: identity.resourceArn || '',
        logType,
        operation: 'AGENTCORE_TRACE',
        accountId: AWS_ACCOUNT_ID,
        region: AWS_REGION,
        inputTokenCount: 0,
        outputTokenCount: 0,
        userMessage: content.userMessage,
        agentResponse: content.agentResponse,
        traceData: { traceId: identity.traceId, sessionId: identity.sessionId, ...extractAgentCoreExecutionFlow(records || [], resourceName) }
    };
}

module.exports = {
    classifyRecord, parseLogRecord, resolveTraceIdentity, resolveTraceContent, buildConversationPair
};
