const test = require('node:test');
const assert = require('node:assert/strict');
const {
    countConversationSignalsInEvents,
    computeWalkPriority,
    enrichCheckpointAfterIngest
} = require('../logGroupConversationSignal');

test('countConversationSignalsInEvents detects OpenInference markers', () => {
    const hits = countConversationSignalsInEvents([
        { message: '{"name":"chat","attributes":{"llm.input_messages.0.message.content":"hi"}}' },
        { message: 'plain startup log' }
    ]);
    assert.equal(hits, 1);
});

test('computeWalkPriority prefers inttest and signal history', () => {
    const inttest = { logGroupName: '/aws/bedrock-agentcore/runtimes/inttest_foo-bar-DEFAULT' };
    const other = { logGroupName: '/aws/bedrock-agentcore/runtimes/foo-bar-DEFAULT' };
    const withSignals = { lastConversationSignalCount: 5, lastMessagesProduced: 2 };
    assert.ok(computeWalkPriority(inttest, undefined) > computeWalkPriority(other, undefined));
    assert.ok(computeWalkPriority(other, withSignals) > computeWalkPriority(other, { emptyMessageStreak: 4 }));
});

test('enrichCheckpointAfterIngest tracks infra-only streak', () => {
    const cp = enrichCheckpointAfterIngest({}, 0, 0, { SPAN: 10, emptyContent: 10 });
    assert.equal(cp.emptyMessageStreak, 1);
    const reset = enrichCheckpointAfterIngest(cp, 0, 3, { SPAN: 1, emptyContent: 1 });
    assert.equal(reset.emptyMessageStreak, 0);
});
