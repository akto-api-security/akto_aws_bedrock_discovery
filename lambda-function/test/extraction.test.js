/**
 * Turning a raw log entry into at most one AKTO message.
 *
 * Bedrock resends the entire conversation on every call, so the naive reading — pair
 * every user turn with the reply — sends each exchange once per subsequent call. On
 * real client logs that was 2755 messages for 132 exchanges, one question sent 68
 * times. Only the final exchange belongs to a given entry; the earlier turns already
 * arrived via their own entries.
 */
const assert = require('assert');
const { load, logEntry, quiet } = require('./harness');
const { section, check, done } = require('./assert-lite');

const state = {};
const { extractConversationPairs, extractTraceData, lastRealUserIndex } = load(state).modules('extractors.js');

const turn = (role, ...blocks) => ({ role, content: blocks });
const text = (t) => ({ text: t });
const toolUse = (name, id) => ({ toolUse: { name, toolUseId: id, input: {} } });
const toolResult = (id, out) => ({ toolResult: { toolUseId: id, content: [text(out)] } });

(async () => {
    section('only the final exchange is emitted');
    const history = [
        turn('user', text('first question')),
        turn('assistant', text('first answer that is long enough')),
        turn('user', text('second question')),
        turn('assistant', text('second answer that is long enough')),
        turn('user', text('third question'))
    ];
    const restore = quiet();
    const pairs = extractConversationPairs(logEntry({ messages: history, answer: 'the final answer, long enough' }));
    restore();

    check('one pair, not one per user turn', () => assert.strictEqual(pairs.length, 1));
    check('it is the LAST question', () => assert.strictEqual(pairs[0].userMessage, 'third question'));
    check('paired with the reply from output, not from history', () =>
        assert.strictEqual(pairs[0].agentResponse, 'the final answer, long enough'));
    check('history depth is reported, not resent', () => assert.strictEqual(pairs[0].conversationTurns, 5));

    section('entries that cannot yield an exchange');
    check('no output body logged at all → nothing', () => {
        const r = quiet();
        const p = extractConversationPairs(logEntry({ output: {} }));
        r();
        assert.strictEqual(p.length, 0);
    });
    check('a reply that is only a tool call → nothing', () => {
        const r = quiet();
        const p = extractConversationPairs(logEntry({
            messages: [turn('user', text('do the thing'))],
            output: { outputBodyJson: { stopReason: 'tool_use', output: { message: { role: 'assistant', content: [toolUse('cf_deploy', 't1')] } } } }
        }));
        r();
        assert.strictEqual(p.length, 0, 'a tool-call-only turn produced a message');
    });
    check('a reply under 10 chars is filtered as noise', () => {
        const r = quiet();
        const p = extractConversationPairs(logEntry({ answer: 'ok' }));
        r();
        assert.strictEqual(p.length, 0);
    });
    check('no messages in the input → nothing', () => {
        const r = quiet();
        const p = extractConversationPairs(logEntry({ messages: [] }));
        r();
        assert.strictEqual(p.length, 0);
    });

    section('a tool result is not a user question');
    // Bedrock returns tool output as a role:user message. Treating it as a question
    // would scope the trace to the wrong point and mislabel the exchange.
    const withTools = [
        turn('user', text('the real question')),
        turn('assistant', text('working on it'), toolUse('read_file', 't1')),
        turn('user', toolResult('t1', 'file contents')),
        turn('assistant', toolUse('cf_validate', 't2')),
        turn('user', toolResult('t2', 'validated'))
    ];
    check('lastRealUserIndex finds the question, not the tool result', () =>
        assert.strictEqual(lastRealUserIndex(withTools), 0));
    check('a mixed toolResult+text block is still not a question', () => {
        const mixed = withTools.concat([turn('user', toolResult('t3', 'out'), text('trailing note'))]);
        assert.strictEqual(lastRealUserIndex(mixed), 0, 'a tool-result carrier was read as a question');
    });

    section('the trace covers this exchange, not the whole conversation');
    const entry = logEntry({ messages: withTools, answer: 'done, and long enough' });
    const trace = extractTraceData(entry, 'my-agent');
    check('both of this turn\'s tools are reported', () => {
        assert.deepStrictEqual(trace.toolsSummary.tools.sort(), ['cf_validate', 'read_file']);
        assert.strictEqual(trace.toolsSummary.totalToolCalls, 2);
    });
    check('step 0 is the agent itself', () => {
        assert.strictEqual(trace.executionFlow[0].type, 'agent');
        assert.strictEqual(trace.executionFlow[0].name, 'my-agent');
    });
    check('each tool call is joined to its result by toolUseId', () => {
        const step = trace.executionFlow.find((s) => s.tool === 'read_file');
        assert.strictEqual(step.result, 'file contents');
    });
    check('a turn before the question is NOT included', () => {
        // The same tools, but now behind a newer question — they belong to the earlier
        // entry, which already reported them.
        const later = withTools.concat([turn('user', text('a brand new question'))]);
        const scoped = extractTraceData(logEntry({ messages: later }), 'my-agent');
        assert.strictEqual(scoped.executionFlow.length, 0, `carried ${scoped.executionFlow.length} stale step(s)`);
    });

    section('content shapes');
    const { extractTextFromContent, cleanAgentResponse } = load(state).modules('extractors.js');
    check('an <answer> block is unwrapped', () =>
        assert.strictEqual(cleanAgentResponse('<answer>the real reply</answer>'), 'the real reply'));
    check('raw <thinking> with no answer is not a reply', () =>
        assert.strictEqual(cleanAgentResponse('<thinking>still working</thinking>'), ''));
    check('reasoningContent blocks are skipped, text is found', () => {
        const r = quiet();
        const out = extractTextFromContent([{ reasoningContent: { reasoningText: { text: '' } } }, text('the visible reply')]);
        r();
        assert.strictEqual(out, 'the visible reply');
    });
    check('a non-array content does not throw', () => {
        const r = quiet();
        assert.strictEqual(extractTextFromContent('a plain string'), '');
        r();
    });

    done();
})();
