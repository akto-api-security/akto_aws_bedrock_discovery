/**
 * Pure functions that turn a raw Bedrock model-invocation log entry into
 * AKTO-shaped conversation pairs. No AWS calls, no shared state.
 */
const { AWS_REGION, AWS_ACCOUNT_ID } = require('./config');

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
            harnessRoleSuffix: '',
            harnessName: '',
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
    extractTextFromContent, cleanAgentResponse, removeXMLTags, extractConversationPairs, extractTraceData
};
