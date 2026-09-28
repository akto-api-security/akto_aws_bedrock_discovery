/**
 * Fast heuristics on raw CloudWatch log event text to find groups likely to
 * carry user/agent conversations (OpenInference / gen_ai), without full parsing.
 */

const CONVERSATION_SIGNAL_MARKERS = [
    'llm.input_messages',
    'llm.output_messages',
    '"name":"chat"',
    'invoke_agent Strands Agents',
    'input.value',
    'output.value',
    'openinference.span.kind',
    'gen_ai.user.message',
    'gen_ai.assistant.message',
    'strands.telemetry.tracer'
];

/**
 * @param {Array<{ message?: string }>} events
 * @returns {number}
 */
function countConversationSignalsInEvents(events) {
    let hits = 0;
    for (const event of events || []) {
        const message = event?.message;
        if (!message || typeof message !== 'string') continue;
        for (const marker of CONVERSATION_SIGNAL_MARKERS) {
            if (message.includes(marker)) {
                hits++;
                break;
            }
        }
    }
    return hits;
}

/**
 * Higher = walk earlier this run. Uses manifest checkpoint hints from prior runs.
 * @param {{ logGroupName: string }} logGroup
 * @param {object} [checkpoint]
 */
function computeWalkPriority(logGroup, checkpoint) {
    let score = 0;
    if (!checkpoint) {
        score += 1_000_000;
    }
    const signals = Number(checkpoint?.lastConversationSignalCount) || 0;
    const produced = Number(checkpoint?.lastMessagesProduced) || 0;
    score += signals * 15_000;
    score += produced * 40_000;
    if (logGroup.logGroupName.includes('inttest_')) {
        score += 200_000;
    }
    const streak = Number(checkpoint?.emptyMessageStreak) || 0;
    score -= streak * 30_000;
    return score;
}

/**
 * @param {object} checkpoint
 * @param {number} messagesProduced
 * @param {number} signalCount
 * @param {{ emptyContent?: number, SPAN?: number }} [parseStats]
 */
function enrichCheckpointAfterIngest(checkpoint, messagesProduced, signalCount, parseStats = {}) {
    const next = { ...checkpoint };
    next.lastConversationSignalCount = Math.max(signalCount, next.lastConversationSignalCount || 0);
    next.lastMessagesProduced = messagesProduced;
    if (messagesProduced > 0 || signalCount > 0) {
        next.emptyMessageStreak = 0;
        next.skipUntilMs = undefined;
        if (messagesProduced > 0) {
            return next;
        }
    }
    const hadSpans = (parseStats.SPAN || 0) > 0;
    const emptyTraces = (parseStats.emptyContent || 0) > 0;
    if (hadSpans && emptyTraces && signalCount === 0) {
        next.emptyMessageStreak = (next.emptyMessageStreak || 0) + 1;
    }
    return next;
}

module.exports = {
    CONVERSATION_SIGNAL_MARKERS,
    countConversationSignalsInEvents,
    computeWalkPriority,
    enrichCheckpointAfterIngest
};
