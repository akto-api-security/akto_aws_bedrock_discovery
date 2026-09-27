const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildDiscoveredRuntimeIdSet,
    logGroupMatchesDiscoveredRuntime,
    filterLogGroupsForIngest
} = require('../logGroupScope');

const PREFIX = '/aws/bedrock-agentcore/runtimes/';

const agents = {
    'runtime-a': { resourceType: 'RUNTIME', resourceId: 'eval_test_00-LrMipgDN73' },
    'harness-b': { resourceType: 'HARNESS', resourceId: 'harness_obo_test-DaV22OEHnx' }
};

const g = (name, runtimeId = '') => ({ logGroupName: name, runtimeId });

test('buildDiscoveredRuntimeIdSet collects runtime and harness ids', () => {
    const ids = buildDiscoveredRuntimeIdSet(agents);
    assert.equal(ids.size, 2);
    assert.ok(ids.has('eval_test_00-LrMipgDN73'));
});

test('logGroupMatchesDiscoveredRuntime by runtimeId or path prefix', () => {
    const ids = buildDiscoveredRuntimeIdSet(agents);
    assert.ok(logGroupMatchesDiscoveredRuntime(
        g(`${PREFIX}eval_test_00-LrMipgDN73-APPROVED`, 'eval_test_00-LrMipgDN73'),
        ids,
        PREFIX
    ));
    assert.equal(logGroupMatchesDiscoveredRuntime(
        g(`${PREFIX}inttest_foo-bar-DEFAULT`, 'inttest_foo-bar'),
        ids,
        PREFIX
    ), false);
});

test('filterLogGroupsForIngest scope discovered drops orphans', () => {
    const all = [
        g(`${PREFIX}eval_test_00-LrMipgDN73-DEFAULT`, 'eval_test_00-LrMipgDN73'),
        g(`${PREFIX}orphan_runtime-xyz-DEFAULT`, 'orphan_runtime-xyz')
    ];
    const { groups, stats } = filterLogGroupsForIngest(all, {
        discoveredAgents: agents,
        logGroupCheckpoints: {},
        scope: 'discovered',
        includeSubstrings: [],
        excludeSubstrings: [],
        emptyPollCooldownHours: 0
    });
    assert.equal(groups.length, 1);
    assert.equal(stats.skippedOrphan, 1);
    assert.equal(stats.selected, 1);
});

test('filterLogGroupsForIngest falls back to all when no discovered ids', () => {
    const all = [g(`${PREFIX}a-DEFAULT`, 'a'), g(`${PREFIX}b-DEFAULT`, 'b')];
    const { groups, stats } = filterLogGroupsForIngest(all, {
        discoveredAgents: {},
        logGroupCheckpoints: {},
        scope: 'discovered',
        includeSubstrings: [],
        excludeSubstrings: [],
        emptyPollCooldownHours: 0
    });
    assert.equal(groups.length, 2);
    assert.match(stats.scope, /all \(no discovered/);
});

test('empty poll cooldown skips group', () => {
    const name = `${PREFIX}eval_test_00-LrMipgDN73-DEFAULT`;
    const { groups, stats } = filterLogGroupsForIngest([g(name, 'eval_test_00-LrMipgDN73')], {
        discoveredAgents: agents,
        logGroupCheckpoints: {
            [name]: { lastEmptyPollAt: new Date().toISOString(), lastEventTimestamp: Date.now() }
        },
        scope: 'discovered',
        includeSubstrings: [],
        excludeSubstrings: [],
        emptyPollCooldownHours: 24
    });
    assert.equal(groups.length, 0);
    assert.equal(stats.skippedEmptyCooldown, 1);
});
