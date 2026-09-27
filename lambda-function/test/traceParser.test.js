const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
    parseLogRecord,
    resolveTraceIdentity,
    resolveTraceContent,
    buildConversationPair
} = require('../traceParser');

const samplePath = path.join(
    __dirname,
    '../../.s3-markers/700589248308/us-east-1/agentcore-tracing/samples/0eda4b4101765f9e2b376532.json'
);

test('resolveTraceContent extracts OpenInference chat span from customer sample', () => {
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    const records = sample.events.map(parseLogRecord).filter(Boolean);
    const byTrace = new Map();
    for (const r of records) {
        if (!r.traceId) continue;
        if (!byTrace.has(r.traceId)) byTrace.set(r.traceId, []);
        byTrace.get(r.traceId).push(r);
    }
    const traceRecords = byTrace.get('51a41318ef6e4400b57964d2f1795095');
    assert.ok(traceRecords?.length);

    const content = resolveTraceContent(traceRecords);
    assert.match(content.userMessage, /integration test/i);
    assert.match(content.agentResponse, /Test successful/i);

    const identity = resolveTraceIdentity(traceRecords);
    const pair = buildConversationPair(
        identity,
        content,
        { logGroupName: sample.logGroupName, runtimeId: sample.runtimeId },
        {},
        {},
        traceRecords
    );
    assert.equal(pair.inputTokenCount, 38);
    assert.equal(pair.outputTokenCount, 2);
    assert.equal(pair.traceData.sessionId, '58034501-d0d5-4591-b2ce-ba522ff46887');
});
