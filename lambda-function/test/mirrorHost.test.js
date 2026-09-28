const test = require('node:test');
const assert = require('node:assert/strict');
const { agentMirrorHostLabel, resolveMirrorHost, bedrockRuntimeMirrorHost } = require('../mirrorHost');

test('agentMirrorHostLabel prefers readable name with id suffix', () => {
    const label = agentMirrorHostLabel({ name: 'harness_test_yang', id: 'harness_test_yang-8LuE7V8eba' });
    assert.match(label, /harness-test-yang/);
    assert.match(label, /8lue7v8eba|8lu/i);
});

test('resolveMirrorHost uses agent name for AgentCore runtime conversations', () => {
    const host = resolveMirrorHost({
        logType: 'RUNTIME',
        botName: 'gen3_test',
        runtimeId: 'gen3_test-QdJ7Gj5Iqh',
        region: 'us-east-1'
    }, true, 'us-east-1');
    assert.match(host, /^gen3-test/);
    assert.match(host, /\.agent\.bedrock-agentcore\.us-east-1\.amazonaws\.com$/);
});

test('resolveMirrorHost keeps bedrock-runtime for unknown conversation type', () => {
    const host = resolveMirrorHost({ logType: 'UNKNOWN', region: 'us-east-1' }, true, 'us-east-1');
    assert.equal(host, bedrockRuntimeMirrorHost('us-east-1'));
});

test('resolveMirrorHost discovery harness matches conversation host', () => {
    const discovery = resolveMirrorHost({
        resourceType: 'HARNESS',
        harnessName: 'litellm_harness',
        harnessId: 'litellm_harness-nujEZDmX9h'
    }, false, 'us-east-1');
    const conversation = resolveMirrorHost({
        logType: 'HARNESS',
        botName: 'litellm_harness',
        harnessId: 'litellm_harness-nujEZDmX9h',
        region: 'us-east-1'
    }, true, 'us-east-1');
    assert.equal(discovery, conversation);
});
