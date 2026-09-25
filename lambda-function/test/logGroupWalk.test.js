const test = require('node:test');
const assert = require('node:assert/strict');
const { orderLogGroupsForWalk } = require('../logGroupWalk');

const g = (name) => ({ logGroupName: name, runtimeId: name });

test('orderLogGroupsForWalk puts unchecked groups first', () => {
    const all = [g('/aws/a'), g('/aws/b'), g('/aws/c')];
    const checkpoints = { '/aws/b': { lastEventTimestamp: 1 } };
    const { groups, uncheckedCount, checkedCount } = orderLogGroupsForWalk(all, checkpoints, '');
    assert.equal(uncheckedCount, 2);
    assert.equal(checkedCount, 1);
    assert.deepEqual(groups.map((x) => x.logGroupName), ['/aws/a', '/aws/c', '/aws/b']);
});

test('orderLogGroupsForWalk rotates checked queue after cursor', () => {
    const all = [g('/aws/a'), g('/aws/b'), g('/aws/c'), g('/aws/d')];
    const checkpoints = {
        '/aws/a': { lastEventTimestamp: 1 },
        '/aws/b': { lastEventTimestamp: 1 },
        '/aws/c': { lastEventTimestamp: 1 },
        '/aws/d': { lastEventTimestamp: 1 }
    };
    const { groups } = orderLogGroupsForWalk(all, checkpoints, '/aws/b');
    assert.deepEqual(groups.map((x) => x.logGroupName), ['/aws/c', '/aws/d', '/aws/a', '/aws/b']);
});
