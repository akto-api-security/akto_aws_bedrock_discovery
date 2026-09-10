/**
 * How messages are batched and sent: bounded by count and bytes, deadline-aware, and
 * never silently partial.
 *
 * SEND_BATCH_SIZE is 1 because AKTO's ingest API caps a single JSON string, and one
 * message per POST is the only setting under which a request body cannot exceed a
 * single message however large a conversation grows.
 */
const assert = require('assert');
const path = require('path');
const { LAMBDA, load, quiet } = require('./harness');
const { section, check, acheck, done } = require('./assert-lite');

const state = {};
const msg = (bytes) => ({
    path: '/model/m/converse',
    requestHeaders: JSON.stringify({ 'X-Request-Id': `id-${bytes}` }),
    requestPayload: 'x'.repeat(Math.max(1, bytes))
});

(async () => {
    section('one message per request by default');
    let { modules, config } = load(state);
    let akto = modules('aktoClient.js');
    check('SEND_BATCH_SIZE defaults to 1', () => assert.strictEqual(config.SEND_BATCH_SIZE, 1));
    check('25 messages become 25 requests', () => {
        assert.deepStrictEqual(akto.buildBatches(Array.from({ length: 25 }, () => msg(10))).map((b) => b.length),
            Array(25).fill(1));
    });
    check('tunable without a redeploy', () => {
        const tuned = load(state, { SEND_BATCH_SIZE: '10' }).modules('aktoClient.js');
        assert.deepStrictEqual(tuned.buildBatches(Array.from({ length: 25 }, () => msg(10))).map((b) => b.length), [10, 10, 5]);
    });
    check('every message appears exactly once', () => {
        const msgs = Array.from({ length: 25 }, (_, i) => ({ id: i }));
        const flat = akto.buildBatches(msgs).flat();
        assert.strictEqual(flat.length, 25);
        assert.strictEqual(new Set(flat.map((m) => m.id)).size, 25);
    });
    check('an empty list produces no batches', () => assert.deepStrictEqual(akto.buildBatches([]), []));

    section('bounded by bytes as well as count');
    ({ modules, config } = load(state, { SEND_BATCH_SIZE: '10' }));
    akto = modules('aktoClient.js');
    check('large messages split before the count limit', () => {
        const batches = akto.buildBatches(Array.from({ length: 6 }, () => msg(2 * 1024 * 1024)));
        assert.ok(batches.length > 1, 'the byte cap never triggered');
        for (const batch of batches) {
            assert.ok(Buffer.byteLength(JSON.stringify(batch), 'utf8') <= config.MAX_BATCH_BYTES * 1.05);
        }
    });
    check('an oversized single message is sent alone, not dropped', () => {
        const restore = quiet();
        const batches = akto.buildBatches([msg(10), msg(6 * 1024 * 1024), msg(10)]);
        restore();
        assert.ok(batches.some((b) => b.length === 1 && b[0].requestPayload.length > 5 * 1024 * 1024));
        assert.strictEqual(batches.flat().length, 3, 'a message was lost');
    });

    section('sending stops before a deadline it cannot meet');
    ({ modules, config } = load(state));
    akto = modules('aktoClient.js');
    check('SEND_DEADLINE_MARGIN_MS is 15s', () => assert.strictEqual(config.SEND_DEADLINE_MARGIN_MS, 15000));

    await acheck('refuses to start a batch with no time left', async () => {
        state.posts = [];
        const restore = quiet();
        let threw = null;
        try { await akto.sendToDataIngestionService(Array.from({ length: 30 }, () => msg(10)), () => 5000); }
        catch (e) { threw = e; }
        restore();
        assert.ok(threw, 'sent into a deadline it could not meet');
        assert.match(threw.message, /Deadline reached/);
        assert.strictEqual(state.posts.length, 0, 'a request went out below the margin');
    });
    await acheck('the error says the remainder will be retried', async () => {
        const restore = quiet();
        let threw = null;
        try { await akto.sendToDataIngestionService([msg(10)], () => 1000); } catch (e) { threw = e; }
        restore();
        assert.match(threw.message, /resent next run/i);
    });
    await acheck('with time available every message is sent', async () => {
        state.posts = [];
        const restore = quiet();
        const result = await akto.sendToDataIngestionService(Array.from({ length: 25 }, () => msg(10)), () => 800000);
        restore();
        assert.strictEqual(state.posts.length, 25);
        assert.strictEqual(result.sent, 25);
        assert.strictEqual(result.quarantined.length, 0);
    });
    await acheck('no timeLeft() supplied means no deadline logic', async () => {
        state.posts = [];
        const restore = quiet();
        await akto.sendToDataIngestionService([msg(10)], undefined);
        restore();
        assert.strictEqual(state.posts.length, 1);
    });

    section('the trace cap bounds one message');
    const { config: cfg } = load(state);
    const { extractTraceData, capTraceData } = load(state).modules('extractors.js');
    check('MAX_TRACE_BYTES is 64KB', () => assert.strictEqual(cfg.MAX_TRACE_BYTES, 65536));
    check('tool results are truncated before steps are dropped', () => {
        const trace = {
            executionFlow: [{ step: 0, type: 'agent', name: 'bot' }].concat(
                Array.from({ length: 20 }, (_, i) => ({ step: i + 1, type: 'tool-call', tool: `t${i}`, result: 'R'.repeat(20000) }))),
            toolsSummary: { tools: Array.from({ length: 20 }, (_, i) => `t${i}`), totalToolCalls: 20 }
        };
        const capped = capTraceData(trace, cfg.MAX_TRACE_BYTES);
        assert.ok(Buffer.byteLength(JSON.stringify(capped), 'utf8') <= cfg.MAX_TRACE_BYTES, 'still over the cap');
        assert.strictEqual(capped.executionFlow.length, 21, 'a step was dropped when truncating results would have sufficed');
        assert.strictEqual(capped.toolsSummary.tools.length, 20, 'toolsSummary must never be trimmed');
    });
    check('a trace under the cap is untouched', () => {
        const small = { executionFlow: [{ step: 0, type: 'agent', name: 'bot' }], toolsSummary: { tools: [] } };
        assert.deepStrictEqual(capTraceData(small, cfg.MAX_TRACE_BYTES), small);
    });

    done();
})();
