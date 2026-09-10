/**
 * The checkpoint records "every log file up to this moment has been read".
 *
 * Its original bug: it lived inside the send path, so a run that read files but built
 * no messages recorded nothing — and re-read the same files forever while the 3-day
 * lookback slid past the data behind it.
 */
const assert = require('assert');
const { load, logEntry, mkFiles, quiet, invoke } = require('./harness');
const { section, check, done } = require('./assert-lite');

const state = { files: null, manifest: null, traceManifest: null };
const readManifest = () => (state.manifest ? JSON.parse(state.manifest) : null);

(async () => {
    section('files read but nothing extractable — the original bug');
    state.manifest = null;
    state.files = mkFiles(5);
    // Every entry logs a request but no response, as ~75% of this client's traffic does.
    state.entriesFor = (key) => [logEntry({ i: Number(String(key).match(/f(\d+)/)[1]), output: {} })];
    state.failPlan = () => null;

    let restore = quiet();
    let { handler } = load(state);
    let res = await invoke(handler);
    restore();
    let body = JSON.parse(res.body);

    check('all files are read', () => assert.strictEqual(body.s3.filesDone, 5));
    check('nothing is sent — there is no exchange to send', () => assert.strictEqual(body.s3.totalSent, 0));
    check('the manifest is STILL written  ← the fix', () => assert.ok(readManifest(), 'no checkpoint written'));
    check('the checkpoint is the newest file read, not wall-clock', () => {
        assert.strictEqual(readManifest().lastProcessedTimestamp, state.files[4].LastModified.toISOString());
    });
    check('discovered agents survive the write', () => assert.ok(readManifest().discoveredAgents));

    section('a second run does not re-read them');
    restore = quiet();
    ({ handler } = load(state));
    res = await invoke(handler);
    restore();
    check('zero files re-read', () => assert.strictEqual(JSON.parse(res.body).s3.filesDone, 0));

    section('the checkpoint never moves backwards');
    const ahead = new Date(Date.now() + 3600e3).toISOString();
    state.manifest = JSON.stringify({ version: '2.4', lastProcessedTimestamp: ahead, discoveredAgents: {} });
    state.files = mkFiles(3);
    restore = quiet();
    ({ handler } = load(state));
    await invoke(handler);
    restore();
    check('a newer stored position is kept', () => {
        assert.strictEqual(readManifest().lastProcessedTimestamp, ahead,
            'an older position overwrote a newer one — concurrent runs would lose data');
    });

    section('an unreadable file does not stall the backlog');
    state.manifest = null;
    state.files = mkFiles(5);
    state.entriesFor = (key) => {
        if (key.includes('f2')) throw Object.assign(new Error('corrupt gzip'), { name: 'Error' });
        return [logEntry({ i: Number(String(key).match(/f(\d+)/)[1]) })];
    };
    restore = quiet();
    ({ handler } = load(state));
    res = await invoke(handler);
    restore();
    body = JSON.parse(res.body);
    check('the run continues past it', () => assert.strictEqual(res.statusCode, 200));
    check('it is counted as failed, not silently skipped', () => assert.strictEqual(body.s3.filesFailed, 1));
    check('the other files are still processed', () => assert.strictEqual(body.s3.filesDone, 4));
    check('the bad key is recorded in the manifest', () => {
        const failed = readManifest().failedFiles;
        assert.ok(Array.isArray(failed) && failed.some((f) => f.key.includes('f2')), 'failedFiles missing the key');
    });
    check('progress still advances past it', () => {
        assert.strictEqual(readManifest().lastProcessedTimestamp, state.files[4].LastModified.toISOString());
    });

    done();
})();
