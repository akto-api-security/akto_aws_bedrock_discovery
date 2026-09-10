/**
 * A message AKTO refuses permanently must not wedge the pipeline.
 *
 * The client's failure: 100 messages, one refused with an HTTP 500 the server returns
 * every time. The throw aborted the run, the checkpoint never advanced, and the next
 * run re-delivered everything that had already succeeded — four identical runs, ~332
 * duplicates, zero progress. These tests pin that shut, and pin that a genuinely
 * transient failure still holds the checkpoint so the data is retried.
 */
const assert = require('assert');
const { load, logEntry, mkFiles, quiet, invoke, awsError } = require('./harness');
const { section, check, done } = require('./assert-lite');

const OVERSIZE = '<title>Error 500 JSON string length exceeds maximum allowed length of 262144</title>';
const POISON = 'req-3';

const state = {
    files: null, manifest: null, traceManifest: null,
    entriesFor: (key) => [logEntry({ i: Number(String(key).match(/f(\d+)/)[1]) })]
};

(async () => {
    section('a message the server always refuses');
    state.manifest = null;
    state.files = mkFiles(10);
    state.failPlan = (ids) => (ids.includes(POISON) ? { status: 500, body: OVERSIZE } : null);

    let restore = quiet();
    let { handler } = load(state);
    let res = await invoke(handler);
    restore();
    let body = JSON.parse(res.body);

    check('the run completes instead of aborting', () => assert.strictEqual(res.statusCode, 200));
    check('every other message is still delivered', () => {
        // 10 conversations + 1 first-seen service-agent discovery message, minus the poison one
        assert.strictEqual(body.s3.totalSent, 10, `sent ${body.s3.totalSent}`);
    });
    check('the refused message is quarantined', () => assert.strictEqual(body.s3.messagesQuarantined, 1));
    check('it is retried the full MAX_SEND_ATTEMPTS first', () => {
        assert.strictEqual(state.posts.length, 13, `expected 13 POSTs (10 good + 3 attempts), got ${state.posts.length}`);
    });
    check('the checkpoint advances — this is what stops the replay', () => {
        assert.ok(state.manifest, 'no manifest written');
        assert.strictEqual(JSON.parse(state.manifest).lastProcessedTimestamp,
            state.files[9].LastModified.toISOString());
    });
    check('the manifest names the message, its size and why', () => {
        const [f] = JSON.parse(state.manifest).failedMessages;
        assert.strictEqual(f.requestId, POISON);
        assert.strictEqual(f.status, 500);
        assert.ok(f.bytes > 0, 'no size recorded');
        assert.match(f.reason, /maximum allowed length/);
    });

    section('the next run sends no duplicates');
    // Deliberately NOT regenerating files: mkFiles() is relative to Date.now(), so a
    // fresh list would legitimately look newer than the checkpoint.
    state.failPlan = () => null;
    restore = quiet();
    ({ handler } = load(state));
    res = await invoke(handler);
    restore();
    body = JSON.parse(res.body);
    check('nothing is re-read', () => assert.strictEqual(body.s3.filesDone, 0, `re-read ${body.s3.filesDone}`));
    check('nothing is re-sent', () => assert.strictEqual(state.posts.length, 0, `${state.posts.length} duplicate POST(s)`));

    section('a transient failure still blocks the checkpoint');
    state.manifest = null;
    state.files = mkFiles(10);
    state.failPlan = (ids) => (ids.includes(POISON) ? { status: 503, body: 'Service Unavailable' } : null);
    restore = quiet();
    ({ handler } = load(state));
    res = await invoke(handler);
    restore();
    check('the run fails rather than skipping recoverable data', () => assert.strictEqual(res.statusCode, 500));
    check('nothing is quarantined on a 503', () => {
        const m = state.manifest ? JSON.parse(state.manifest) : {};
        assert.ok(!m.failedMessages, 'a transient failure was wrongly quarantined');
    });

    section('classifying a failure after retries are spent');
    const { isPermanentRejection } = load(state).modules('aktoClient.js');
    const err = (status, body = '') =>
        Object.assign(new Error(`HTTP ${status}: ${body}`), { httpStatus: status, responseBody: body });

    check('500 "maximum allowed length" is permanent', () =>
        assert.strictEqual(isPermanentRejection(err(500, 'JSON string length exceeds maximum allowed length of 262144')), true));
    check('400 is permanent', () => assert.strictEqual(isPermanentRejection(err(400, 'Bad Request')), true));
    check('a plain 500 is transient', () => assert.strictEqual(isPermanentRejection(err(500, 'Internal Server Error')), false));
    check('503 is transient', () => assert.strictEqual(isPermanentRejection(err(503, 'Service Unavailable')), false));
    check('429 is transient, not a 4xx to drop', () => assert.strictEqual(isPermanentRejection(err(429, 'Too Many Requests')), false));
    check('408 is transient', () => assert.strictEqual(isPermanentRejection(err(408, 'Request Timeout')), false));
    check('a timeout with no status is transient', () =>
        assert.strictEqual(isPermanentRejection(awsError('AbortError', 'aborted')), false));

    done();
})();
