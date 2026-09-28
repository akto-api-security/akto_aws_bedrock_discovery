const test = require('node:test');
const assert = require('node:assert/strict');
const { orderLogGroupsForWalk } = require('../logGroupWalk');

const g = (name) => ({ logGroupName: name, runtimeId: name });

test('orderLogGroupsForWalk puts unchecked groups first when priority ties', () => {
    const all = [g('/aws/a'), g('/aws/b'), g('/aws/c')];
    const checkpoints = { '/aws/b': { lastEventTimestamp: 1 } };
    const { groups, uncheckedCount, checkedCount } = orderLogGroupsForWalk(all, checkpoints, '');
    assert.equal(uncheckedCount, 2);
    assert.equal(checkedCount, 1);
    assert.deepEqual(groups.map((x) => x.logGroupName), ['/aws/a', '/aws/c', '/aws/b']);
});

test('orderLogGroupsForWalk prefers inttest and conversation signals', () => {
    const all = [
        g('/aws/bedrock-agentcore/runtimes/foo-DEFAULT'),
        g('/aws/bedrock-agentcore/runtimes/inttest_foo-DEFAULT'),
        g('/aws/bedrock-agentcore/runtimes/bar-DEFAULT')
    ];
    const checkpoints = {
        '/aws/bedrock-agentcore/runtimes/foo-DEFAULT': { lastEventTimestamp: 1, lastConversationSignalCount: 20 },
        '/aws/bedrock-agentcore/runtimes/bar-DEFAULT': { lastEventTimestamp: 1, emptyMessageStreak: 5 }
    };
    const { groups } = orderLogGroupsForWalk(all, checkpoints, '');
    assert.equal(groups[0].logGroupName, '/aws/bedrock-agentcore/runtimes/inttest_foo-DEFAULT');
});

test('orderLogGroupsForWalk sorts checked groups by priority not cursor', () => {
    const all = [g('/aws/a'), g('/aws/b'), g('/aws/c'), g('/aws/d')];
    const checkpoints = {
        '/aws/a': { lastEventTimestamp: 1, lastMessagesProduced: 3 },
        '/aws/b': { lastEventTimestamp: 1, emptyMessageStreak: 4 },
        '/aws/c': { lastEventTimestamp: 1, lastConversationSignalCount: 8 },
        '/aws/d': { lastEventTimestamp: 1 }
    };
    const { groups } = orderLogGroupsForWalk(all, checkpoints, '/aws/b');
    assert.equal(groups[0].logGroupName, '/aws/a');
    assert.equal(groups[1].logGroupName, '/aws/c');
});
