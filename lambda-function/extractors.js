/**
 * Pure functions that turn a raw Bedrock model-invocation log entry into
 * AKTO-shaped conversation pairs. No AWS calls, no shared state.
 */
const { AWS_REGION, AWS_ACCOUNT_ID, MAX_TRACE_BYTES } = require('./config');

/** Pulls plain text out of a Bedrock content-block (array format expected from AWS APIs). */
function extractTextFromContent(content) {
    // AWS Bedrock APIs always return content as array: [{text: "..."}, ...]
    if (!Array.isArray(content)) {
        console.warn(
            `⚠️ Content is not array (expected array from AWS Bedrock API): ` +
            `type=${typeof content}, value=${JSON.stringify(content).substring(0, 100)}`
        );
        return '';
    }

    // Find first item with text property
    const item = content.find((c) => c.text);
    if (!item) {
        console.warn(`⚠️ No text found in content array. Array length: ${content.length}, items: ${JSON.stringify(content).substring(0, 100)}`);
        return '';
    }

    return item.text;
}

/** Strips <function_calls>/<function_results> blocks and unwraps <answer> tags; drops replies shorter than 10 chars. */
function cleanAgentResponse(rawResponse) {
    if (!rawResponse) return '';
    if (rawResponse.includes('<answer>') && rawResponse.includes('</answer>')) {
        const answer = rawResponse.substring(rawResponse.indexOf('<answer>') + 8, rawResponse.indexOf('</answer>')).trim();
        if (answer) return answer;
    }
    // Raw <thinking> scratch text with no <answer> — an in-progress step, not a real reply.
    if (rawResponse.includes('<thinking>') || rawResponse.includes('</thinking>')) return '';
    let cleaned = removeXMLTags(rawResponse, 'function_calls');
    cleaned = removeXMLTags(cleaned, 'function_results').trim();
    return cleaned.length >= 10 ? cleaned : '';
}

/** Removes a named XML tag and everything between its open/close pair. */
function removeXMLTags(text, tag) {
    return text.replace(new RegExp(`<${tag}>.*?</${tag}>`, 'gs'), '');
}

/**
 * Extracts the one exchange this log entry actually represents: the assistant's
 * response (from the output field) paired with the most recent user message.
 *
 * Returns an array (0 or 1 pairs) because callers iterate it.
 */
function extractConversationPairs(logEntry) {
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
        // Type detection and resource lookup now handled in s3Logs.js via discovery mappings
        const baseFields = {
            timestamp: logEntry.timestamp,
            requestId: logEntry.requestId,
            modelId: logEntry.modelId,
            arn,
            logType: '',
            agentId: '',
            harnessId: '',
            runtimeAgentId: '',
            harnessRoleSuffix: '',
            harnessName: '',
            operation: logEntry.operation || 'Unknown',
            accountId: logEntry.accountId || AWS_ACCOUNT_ID,
            region: logEntry.region || AWS_REGION,
            inputTokenCount: logEntry.input?.inputTokenCount || 0,
            outputTokenCount: logEntry.output?.outputTokenCount || 0,
            awsMetadata: {}
        };

        if (finalAssistantResponse && userMessages.length > 0) {
            pairs.push({
                ...baseFields,
                userMessage: userMessages[userMessages.length - 1],
                agentResponse: finalAssistantResponse,
                // How much history this call carried — useful for spotting long
                // conversations without re-sending their turns.
                conversationTurns: messages.length
            });
        }
    } catch (error) {
        console.error(`❌ Error extracting conversation pairs: ${error.message}`);
    }
    return pairs;
}

/** Pulls an action-type label out of a tool call's input, if its schema has one — direct shape first, then one level into every input key. */
function extractToolActionType(input) {
    if (!input || typeof input !== 'object') return 'unknown';
    if (input.action?.type) return input.action.type;
    for (const value of Object.values(input)) {
        if (value?.action?.type) return value.action.type;
    }
    return 'unknown';
}

/**
 * Index of the last user message that is a real question rather than a tool result.
 *
 * That message is the one extractConversationPairs emits, so everything after it is
 * the work done to answer it — which is exactly the trace this log entry should
 * report. Returns -1 when there is no such message, in which case the caller keeps
 * the whole array rather than guessing.
 */
function lastRealUserIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role !== 'user') continue;
        const blocks = Array.isArray(message.content) ? message.content : [];
        const hasText = blocks.some((b) => b && b.text !== undefined);
        const isToolResult = blocks.some((b) => b && b.toolResult);
        if (hasText && !isToolResult) return i;
    }
    return -1;
}

/**
 * Caps one trace so a single pathological conversation can never produce a message
 * too large for the downstream broker. Tool *results* are the bulk of the bytes, so
 * they are truncated (longest first) before anything structural is dropped: which
 * tools ran, in what order, is worth more than the full text of what they returned.
 */
function capTraceData(trace, maxBytes) {
    const size = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
    if (size(trace) <= maxBytes) return trace;

    const steps = [...(trace.executionFlow || [])];
    // Longest results first — one huge result is the usual cause.
    const order = steps
        .map((s, i) => ({ i, len: String(s.result || '').length }))
        .sort((a, b) => b.len - a.len);

    for (const { i } of order) {
        if (size(trace) <= maxBytes) break;
        const result = String(steps[i].result || '');
        if (result.length <= 200) continue;
        steps[i] = { ...steps[i], result: `${result.slice(0, 200)}…[truncated ${result.length - 200} chars]`, resultTruncated: true };
        trace = { ...trace, executionFlow: steps };
    }

    // Still too big — the step list itself is the problem, so keep the summary and
    // the first steps rather than emit something the broker will reject outright.
    if (size(trace) > maxBytes) {
        const kept = [];
        for (const step of steps) {
            kept.push(step);
            if (size({ ...trace, executionFlow: kept }) > maxBytes) { kept.pop(); break; }
        }
        trace = { ...trace, executionFlow: kept, executionFlowTruncated: { kept: kept.length, total: steps.length } };
    }
    return trace;
}

/**
 * Extracts the tool-call execution trace for a conversation pair, matching each
 * toolUse to its toolResult by toolUseId.
 *
 * Scoped to the exchange being reported, not the whole conversation. Bedrock resends
 * the entire history on every call, so walking all of it made message N carry the
 * tool results of turns 1…N — the same duplication extractConversationPairs already
 * removes for the conversation itself. On real client logs that was 88% of the
 * payload and grew without bound as a session went on. Each turn's tools still reach
 * AKTO exactly once, on the message for the turn they ran in.
 */
function extractTraceData(logEntry, botName, maxBytes = MAX_TRACE_BYTES) {
    try {
        const allMessages = logEntry.input?.inputBodyJson?.messages || [];
        const from = lastRealUserIndex(allMessages);
        const messages = from >= 0 ? allMessages.slice(from + 1) : allMessages;
        const stopReason = logEntry.output?.outputBodyJson?.stopReason;

        const resultsByToolUseId = {};
        for (const message of messages) {
            if (message.role !== 'user') continue;
            for (const block of message.content || []) {
                const toolResult = block?.toolResult;
                if (toolResult?.toolUseId) {
                    resultsByToolUseId[toolResult.toolUseId] = extractTextFromContent(toolResult.content);
                }
            }
        }

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
            const action = extractToolActionType(item.toolUse?.input);
            const toolUseId = item.toolUse?.toolUseId || '';
            executionFlow.push({ step: i + 1, type: 'tool-call', tool, action, toolUseId, result: resultsByToolUseId[toolUseId] || '' });
            tools.add(tool);
            actions.add(action);
        });

        return capTraceData({
            executionFlow,
            toolsSummary: {
                agentOrchestrator: botName,
                tools: [...tools],
                actions: [...actions],
                totalToolCalls: toolCalls.length,
                executionPattern: `${botName}→${[...tools].join('→')}`
            }
        }, maxBytes);
    } catch (error) {
        console.warn(`⚠️ Trace extraction failed: ${error.message}`);
        return { executionFlow: [], toolsSummary: {} };
    }
}

module.exports = {
    extractTextFromContent, cleanAgentResponse, removeXMLTags, extractConversationPairs, extractTraceData,
    lastRealUserIndex, capTraceData
};
