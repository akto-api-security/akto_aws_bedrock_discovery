/**
 * Behaviour at production scale.
 *
 * The incident: a client's bucket held millions of log files. Every run listed all of
 * them before filtering to the lookback window, ran out of memory, hit the 15-minute
 * timeout and never saved a checkpoint — so every run started over. These tests pin
 * that shut, plus the other scale defects found while fixing it: files sharing one
 * second skipped at a checkpoint, a busy AgentCore log group loaded whole, sequential
 * sending, and overlapping / retried runs.
 */
const assert = require('assert');
const zlib = require('zlib');
const { load, logEntry, mkFiles, quiet, invoke, listObjects } = require('./harness');
const { section, check, acheck, done } = require('./assert-lite');

const HOUR = 3600e3;
const ROOT = 'AWSLogs/123456789012/BedrockModelInvocationLogs/us-east-1/';
const pad = (n) => String(n).padStart(2, '0');
const hourFolder = (ms) => {
    const d = new Date(ms);
    return `${ROOT}${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}/`;
};
const toSecond = (ms) => Math.floor(ms / 1000) * 1000;

/**
 * A bucket in Bedrock's real layout, generated on demand so millions of objects cost no
 * memory: `hours` hour folders ending now, `perHour` files each. Files are delivered
 * `lagMs` after their slot, so the last files of each hour have a LastModified in the
 * NEXT hour — the case that makes ordering across folders matter. A full listing of
 * the bucket throws: the fixed code must never attempt one.
 */
function bedrockBucket({ hours, perHour, lagMs = 90e3, extraObjects = {} }) {
    const now = Date.now();
    const firstHour = Math.floor(now / HOUR) * HOUR - (hours - 1) * HOUR;
    const folders = new Map();
    for (let h = 0; h < hours; h++) folders.set(hourFolder(firstHour + h * HOUR), firstHour + h * HOUR);
    const total = hours * perHour;

    const filesIn = (folder) => {
        const start = folders.get(folder);
        if (start === undefined) return extraObjects[folder] || [];
        const files = [];
        for (let i = 0; i < perHour; i++) {
            const modified = toSecond(start + (i + 0.5) * (HOUR / perHour) + lagMs);
            if (modified > now) break;
            const stamp = new Date(start + i * (HOUR / perHour)).toISOString().replace(/[-:.]/g, '');
            files.push({ Key: `${folder}${stamp}_${String(i).padStart(4, '0')}.json.gz`, LastModified: new Date(modified), Size: 900 });
        }
        return files.concat(extraObjects[folder] || []);
    };

    const list = (input) => {
        const { Prefix = '', Delimiter, MaxKeys = 1000, ContinuationToken } = input;
        if (folders.has(Prefix) || extraObjects[Prefix]) return listObjects(filesIn(Prefix), input);
        const isAncestor = [...folders.keys()].some((folder) => folder.startsWith(Prefix));
        if (!Delimiter && isAncestor) throw new Error(`full listing of ${Prefix} attempted on a ${total}-object bucket`);
        if (!Delimiter) return { Contents: [], CommonPrefixes: [] };   // a folder that doesn't exist
        // A folder level: roll the matching hour folders up to their next path segment.
        const children = new Set();
        for (const folder of folders.keys()) {
            if (!folder.startsWith(Prefix)) continue;
            const rest = folder.slice(Prefix.length);
            children.add(Prefix + rest.slice(0, rest.indexOf('/') + 1));
        }
        const sorted = [...children].sort();
        const from = Number(ContinuationToken || 0);
        return {
            Contents: [],
            CommonPrefixes: sorted.slice(from, from + MaxKeys).map((p) => ({ Prefix: p })),
            NextContinuationToken: from + MaxKeys < sorted.length ? String(from + MaxKeys) : undefined
        };
    };
    return { list, total, now, firstHour };
}

// Point the processor at the bucket root, as a client's default LogsPrefix does.
const DATED = { LOGS_PREFIX: 'AWSLogs/' };
const noExchange = (i) => logEntry({ i, output: {} });   // read and checkpointed, nothing to send
const readJson = (body) => (body ? JSON.parse(body) : null);

(async () => {
    // ------------------------------------------------------------------------------
    section('a 2-million-file bucket: only the lookback window is listed');
    const bucket = bedrockBucket({ hours: 365 * 24, perHour: 230 });
    const state = { manifest: null, traceManifest: null, logGroups: [], listObjects: bucket.list, failPlan: () => null };
    let order = [];
    state.entriesFor = (key) => { order.push(key); return [noExchange(order.length)]; };

    let restore = quiet();
    let { handler } = load(state, DATED);
    const heapBefore = process.memoryUsage().heapUsed;
    let res = await invoke(handler);
    const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
    restore();
    let body = JSON.parse(res.body);

    check('the bucket really is ~2 million objects', () => assert.ok(bucket.total > 2000000, `${bucket.total}`));
    check('the run completes', () => assert.strictEqual(res.statusCode, 200, body.error || ''));
    check('it lists about one day of keys, not the bucket', () => {
        // 24h window + 3h slack + the current hour, at 230 files an hour.
        assert.ok(state.keysListed <= 29 * 230, `listed ${state.keysListed} keys`);
        assert.ok(state.keysListed < bucket.total / 300, `listed ${state.keysListed} of ${bucket.total}`);
    });
    check('in a few dozen S3 calls rather than ~2,000 pages', () => assert.ok(state.listCalls < 60, `${state.listCalls} list calls`));
    check('every file of the last 24 hours is read', () => {
        assert.ok(body.s3.filesDone >= 23 * 230 && body.s3.filesDone <= 25 * 230, `read ${body.s3.filesDone}`);
        assert.strictEqual(body.s3.filesDeferred, 0);
        assert.strictEqual(body.s3.moreToList, false);
    });
    check('memory stays small', () => assert.ok(heapGrowth < 150 * 1048576, `heap grew ${(heapGrowth / 1048576).toFixed(0)}MB`));

    section('files are read in LastModified order across hour folders');
    // The file's index within its hour, from the generator's key format.
    const modifiedOf = (key) => Number(key.slice(-12, -8));
    check('no file is read twice', () => assert.strictEqual(new Set(order).size, order.length));
    check('the order never goes back in time', () => {
        // Rebuild each read file's LastModified from the generator's rule.
        const lastModified = (key) => {
            const folder = key.slice(0, key.lastIndexOf('/') + 1);
            const [y, m, d, h] = folder.slice(ROOT.length, -1).split('/').map(Number);
            const start = Date.UTC(y, m - 1, d, h);
            return toSecond(start + (modifiedOf(key) + 0.5) * (HOUR / 230) + 90e3);
        };
        for (let i = 1; i < order.length; i++) {
            assert.ok(lastModified(order[i]) >= lastModified(order[i - 1]),
                `${order[i]} was read after ${order[i - 1]} but is older`);
        }
    });
    check('the checkpoint is the newest file read', () => {
        const manifest = readJson(state.manifest);
        assert.ok(manifest.lastProcessedTimestamp, 'no checkpoint');
        assert.ok(Array.isArray(manifest.processedKeysAtCheckpoint) && manifest.processedKeysAtCheckpoint.length > 0);
    });

    section('the next run resumes from the checkpoint and lists only recent folders');
    state.keysListed = 0; state.listCalls = 0; order = [];
    restore = quiet();
    ({ handler } = load(state, DATED));
    res = await invoke(handler);
    restore();
    body = JSON.parse(res.body);
    check('nothing is re-read', () => assert.strictEqual(body.s3.filesDone, 0, `re-read ${body.s3.filesDone}`));
    check('only the slack window is listed', () => assert.ok(state.keysListed <= 5 * 230, `listed ${state.keysListed}`));

    // ------------------------------------------------------------------------------
    section('the lookback window is configurable, and a checkpoint is honoured up to MAX_CATCHUP_DAYS');
    state.manifest = null; state.keysListed = 0; order = [];
    restore = quiet();
    ({ handler } = load(state, { ...DATED, LOOKBACK_DAYS: '0.25' }));
    res = await invoke(handler);
    restore();
    check('LOOKBACK_DAYS=0.25 reads about 6 hours', () => {
        const done = JSON.parse(res.body).s3.filesDone;
        assert.ok(done >= 5 * 230 && done <= 7 * 230, `read ${done}`);
    });

    state.manifest = JSON.stringify({ version: '2.4', lastProcessedTimestamp: new Date(Date.now() - 2 * 24 * HOUR).toISOString(), discoveredAgents: {} });
    order = [];
    restore = quiet();
    ({ handler } = load(state, DATED));
    res = await invoke(handler);
    restore();
    check('a 2-day-old checkpoint is resumed in full (default MAX_CATCHUP_DAYS=3)', () => {
        const done = JSON.parse(res.body).s3.filesDone;
        assert.ok(done >= 47 * 230, `read only ${done} — data between the checkpoint and the lookback was skipped`);
    });

    state.manifest = JSON.stringify({ version: '2.4', lastProcessedTimestamp: new Date(Date.now() - 10 * 24 * HOUR).toISOString(), discoveredAgents: {} });
    order = [];
    restore = quiet();
    ({ handler } = load(state, { ...DATED, RUN_BUDGET_MS: '600000' }));
    res = await invoke(handler);
    restore();
    check('a 10-day-old checkpoint is capped at 3 days', () => {
        const done = JSON.parse(res.body).s3.filesDone;
        assert.ok(done <= 73 * 230, `read ${done}`);
        assert.ok(done >= 71 * 230, `read only ${done}`);
    });

    // ------------------------------------------------------------------------------
    section('a backlog larger than one run is drained across runs without skipping');
    state.manifest = null; order = [];
    state.fileDelayMs = 1;
    const reads = [];
    for (let run = 0; run < 12; run++) {
        restore = quiet();
        ({ handler } = load(state, { ...DATED, RUN_BUDGET_MS: '400' }));
        res = await invoke(handler);
        restore();
        reads.push(JSON.parse(res.body).s3.filesDone);
        if (reads[reads.length - 1] === 0) break;
    }
    state.fileDelayMs = 0;
    check('each run stops at its budget and the next continues', () => assert.ok(reads.length > 2, `drained in ${reads.length} run(s): ${reads}`));
    check('every file is read exactly once overall', () => {
        assert.strictEqual(new Set(order).size, order.length, 'a file was read twice');
        assert.ok(order.length >= 23 * 230, `only ${order.length} files read across runs: ${reads}`);
    });

    // ------------------------------------------------------------------------------
    section('large-payload bodies and other services\' logs are not read as log files');
    const small = bedrockBucket({
        hours: 2, perHour: 3,
        extraObjects: { [`${hourFolder(Date.now())}data/`]: [] }
    });
    const nowFolder = hourFolder(Date.now());
    const withData = (input) => {
        const response = small.list(input);
        if (input.Prefix === nowFolder) {
            response.Contents = response.Contents.concat([{ Key: `${nowFolder}data/big-body.json.gz`, LastModified: new Date(), Size: 5000 }]);
        }
        return response;
    };
    const s2 = { manifest: null, traceManifest: null, logGroups: [], listObjects: withData, failPlan: () => null };
    const read2 = [];
    s2.entriesFor = (key) => { read2.push(key); return [noExchange(read2.length)]; };
    restore = quiet();
    ({ handler } = load(s2, DATED));
    await invoke(handler);
    restore();
    check('data/ body objects are skipped', () => assert.ok(!read2.some((k) => k.includes('/data/')), read2.join(',')));
    check('the real log files are read', () => assert.ok(read2.length >= 3, `${read2.length}`));

    const cloudTrail = { Key: 'AWSLogs/123456789012/CloudTrail/us-east-1/2026/01/01/trail.json.gz', LastModified: new Date(), Size: 10 };
    const bedrockFile = { Key: `${nowFolder}20260101T000000Z_x.json.gz`, LastModified: new Date(Date.now() - 60e3), Size: 10 };
    const s3 = { manifest: null, traceManifest: null, logGroups: [], files: [cloudTrail, bedrockFile], failPlan: () => null };
    const read3 = [];
    s3.entriesFor = (key) => { read3.push(key); return [noExchange(1)]; };
    restore = quiet();
    ({ handler } = load(s3, { LOGS_PREFIX: 'AWSLogs/' }));
    await invoke(handler);
    restore();
    check('only Bedrock\'s folders are read when CloudTrail shares AWSLogs/', () => {
        assert.deepStrictEqual(read3, [bedrockFile.Key]);
    });

    // ------------------------------------------------------------------------------
    section('files sharing the checkpoint second are not skipped');
    const second = new Date(toSecond(Date.now() - 30 * 60e3));
    const sameSecond = (name) => ({ Key: `${hourFolder(second.getTime())}${name}.json.gz`, LastModified: second, Size: 10 });
    const s4 = { manifest: null, traceManifest: null, logGroups: [], files: [sameSecond('a'), sameSecond('b')], failPlan: () => null };
    const read4 = [];
    s4.entriesFor = (key) => { read4.push(key.slice(-9)); return [noExchange(read4.length)]; };
    restore = quiet();
    ({ handler } = load(s4, { LOGS_PREFIX: 'AWSLogs/' }));
    await invoke(handler);
    // File c lands in the same second after the first run has finished.
    s4.files.push(sameSecond('c'));
    ({ handler } = load(s4, { LOGS_PREFIX: 'AWSLogs/' }));
    await invoke(handler);
    restore();
    check('the late same-second file is read on the next run', () => assert.deepStrictEqual(read4, ['a.json.gz', 'b.json.gz', 'c.json.gz']));
    check('the manifest records which files share the checkpoint second', () => {
        assert.deepStrictEqual(readJson(s4.manifest).processedKeysAtCheckpoint.map((k) => k.slice(-9)).sort(), ['a.json.gz', 'b.json.gz', 'c.json.gz']);
    });

    // A manifest from before the field existed keeps the strict comparison, so the first
    // run after upgrading re-reads nothing.
    s4.manifest = JSON.stringify({ version: '2.4', lastProcessedTimestamp: second.toISOString(), discoveredAgents: {} });
    read4.length = 0;
    restore = quiet();
    ({ handler } = load(s4, { LOGS_PREFIX: 'AWSLogs/' }));
    await invoke(handler);
    restore();
    check('an upgraded manifest re-reads nothing', () => assert.deepStrictEqual(read4, []));

    // ------------------------------------------------------------------------------
    section('a prefix without dated folders still works, within the budget');
    const flat = { manifest: null, traceManifest: null, logGroups: [], files: mkFiles(30), failPlan: () => null, entriesFor: () => [noExchange(1)] };
    restore = quiet();
    ({ handler } = load(flat));
    res = await invoke(handler);
    restore();
    check('falls back to a full listing and reads everything', () => assert.strictEqual(JSON.parse(res.body).s3.filesDone, 30));

    flat.manifest = null;
    // One key per page, each page slow: a listing that cannot finish inside the budget.
    flat.listObjects = (input) => {
        const t = Date.now();
        while (Date.now() - t < 30) { /* a slow page */ }
        return listObjects(flat.files, { ...input, MaxKeys: 1 });
    };
    restore = quiet();
    ({ handler } = load(flat, { RUN_BUDGET_MS: '300' }));
    res = await invoke(handler);
    restore();
    body = JSON.parse(res.body);
    check('a listing the budget cuts short processes nothing rather than out of order', () => {
        assert.strictEqual(body.s3.filesDone, 0);
        assert.strictEqual(flat.manifest, null, 'checkpoint written from a partial listing');
    });
    check('and reports the backlog instead of claiming completion', () => assert.strictEqual(body.s3.moreToList, true));
    delete flat.listObjects;

    // ------------------------------------------------------------------------------
    section('streaming file reads');
    const big = { manifest: null, traceManifest: null, logGroups: [], files: mkFiles(1), failPlan: () => null };
    big.entriesFor = () => Array.from({ length: 20000 }, (_, i) => noExchange(i));
    restore = quiet();
    ({ handler } = load(big));
    res = await invoke(handler);
    restore();
    check('a 20,000-entry file is read in full', () => {
        const t = JSON.parse(res.body).s3.traffic;
        assert.strictEqual(t.agentCalls + t.serviceAgentIngested + t.serviceAgentCalls + t.noIdentity, 20000);
    });

    const corrupt = { manifest: null, traceManifest: null, logGroups: [], files: mkFiles(3), failPlan: () => null };
    corrupt.entriesFor = () => [noExchange(1)];
    const whole = zlib.gzipSync(Buffer.from(`${JSON.stringify(logEntry({ i: 1 }))}\n`));
    corrupt.rawBodyFor = (key) => (key.includes('f1') ? whole.subarray(0, whole.length - 4) : null);
    restore = quiet();
    ({ handler } = load(corrupt));
    res = await invoke(handler);
    restore();
    body = JSON.parse(res.body);
    check('a truncated gzip fails that file only', () => {
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(body.s3.filesFailed, 1);
        assert.strictEqual(body.s3.filesDone, 2);
        assert.ok(readJson(corrupt.manifest).failedFiles.some((f) => f.key.includes('f1')));
    });

    // ------------------------------------------------------------------------------
    section('one run at a time');
    const lockState = { manifest: null, traceManifest: null, logGroups: [], files: mkFiles(5), failPlan: () => null, fileDelayMs: 30 };
    lockState.entriesFor = () => [noExchange(1)];
    restore = quiet();
    ({ handler } = load(lockState));
    const ctx = (id) => ({ awsRequestId: id, getRemainingTimeInMillis: () => 800000 });
    const [first, second2] = await Promise.all([
        handler({ source: 'aws.events' }, ctx('req-A')),
        handler({ source: 'aws.events' }, ctx('req-B'))
    ]);
    restore();
    const results = [JSON.parse(first.body), JSON.parse(second2.body)];
    check('of two overlapping runs, exactly one works', () => {
        assert.strictEqual(results.filter((r) => r.skipped).length, 1, JSON.stringify(results.map((r) => r.skipped || 'ran')));
        assert.strictEqual(results.filter((r) => r.s3).length, 1);
    });
    check('the files are read once, not twice', () => assert.strictEqual(results.find((r) => r.s3).s3.filesDone, 5));
    check('the lock is released when the run ends', () => assert.ok(JSON.parse(lockState.lock.body).releasedAt));

    lockState.manifest = null;
    restore = quiet();
    ({ handler } = load(lockState));
    res = await handler({ source: 'aws.events' }, ctx('req-A'));
    restore();
    check('a Lambda retry (same request ID) exits without doing anything', () => {
        assert.match(JSON.parse(res.body).skipped || '', /retry/);
        assert.strictEqual(lockState.manifest, null);
    });

    lockState.lock = { body: JSON.stringify({ holder: 'req-dead', acquiredAt: new Date(Date.now() - 20 * 60e3).toISOString(), expiresAt: new Date(Date.now() - 60e3).toISOString(), recentRequestIds: ['req-dead'] }), etag: '"dead"' };
    restore = quiet();
    ({ handler } = load(lockState));
    res = await handler({ source: 'aws.events' }, ctx('req-C'));
    restore();
    check('a lock left by a killed run is taken over once expired', () => assert.ok(JSON.parse(res.body).s3, res.body));

    lockState.lock = { body: JSON.stringify({ holder: 'req-live', acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60e3).toISOString(), recentRequestIds: ['req-live'] }), etag: '"live"' };
    restore = quiet();
    ({ handler } = load(lockState));
    res = await handler({ source: 'aws.events' }, ctx('req-D'));
    restore();
    check('a live lock makes the run skip', () => assert.match(JSON.parse(res.body).skipped || '', /held the lock/));

    lockState.lock = null;
    lockState.lockError = Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    lockState.manifest = null;
    restore = quiet();
    ({ handler } = load(lockState));
    res = await handler({ source: 'aws.events' }, ctx('req-E'));
    restore();
    check('a lock that cannot be used never blocks processing', () => assert.strictEqual(JSON.parse(res.body).s3.filesDone, 5));
    delete lockState.lockError;

    // ------------------------------------------------------------------------------
    section('AgentCore events are processed in chunks');
    // 3,000 events, two per millisecond, across three 1,000-event pages — so chunk cuts
    // land inside a millisecond.
    const TOTAL = 3000;
    const events = Array.from({ length: TOTAL }, (_, i) => ({ timestamp: 1000 + Math.floor(i / 2), eventId: `e${i}` }));
    const cw = { logEvents: events };
    const { readNewLogEventsInChunks: read } = load(cw).modules('logGroupReader.js');
    const chunks = [];
    restore = quiet();
    await read('/g', 0, { timeLeft: () => 1e9, timeSafetyMarginMs: 0, chunkSize: 1000, onChunk: async (evts, cp) => { chunks.push({ ids: evts.map((e) => e.eventId), cp }); } });
    restore();
    check('every event is handed over exactly once', () => {
        const ids = chunks.flatMap((c) => c.ids);
        assert.strictEqual(ids.length, TOTAL, `${ids.length} handed over`);
        assert.strictEqual(new Set(ids).size, TOTAL);
    });
    check('more than one chunk was used', () => assert.ok(chunks.length > 1, `${chunks.length} chunk(s)`));
    check('no chunk splits a millisecond it cannot finish', () => {
        for (const c of chunks.slice(0, -1)) {
            const maxMs = Math.max(...c.ids.map((id) => events[Number(id.slice(1))].timestamp));
            assert.ok(c.cp >= maxMs, `checkpoint ${c.cp} behind events at ${maxMs}`);
            assert.ok(!events.some((e) => e.timestamp > c.cp && e.timestamp <= maxMs && !c.ids.includes(e.eventId)));
        }
    });

    // Stopped by the clock part-way: resuming from the checkpoint loses nothing.
    const handed = [];
    let pages = 0;
    restore = quiet();
    let cp = 0;
    await read('/g', 0, {
        timeLeft: () => (pages++ < 2 ? 1e9 : 0), timeSafetyMarginMs: 1, chunkSize: 5000,
        onChunk: async (evts, checkpoint) => { handed.push(...evts.map((e) => e.eventId)); cp = checkpoint; }
    });
    await read('/g', cp, { timeLeft: () => 1e9, timeSafetyMarginMs: 0, chunkSize: 1000, onChunk: async (evts) => { handed.push(...evts.map((e) => e.eventId)); } });
    restore();
    check('a run cut short resumes without gaps or repeats', () => {
        assert.strictEqual(new Set(handed).size, TOTAL, `${new Set(handed).size} distinct of ${TOTAL}`);
        assert.strictEqual(handed.length, TOTAL, `${handed.length} handed over (duplicates)`);
    });

    // ------------------------------------------------------------------------------
    section('sending runs several requests at once');
    const sendState = { fetchDelayMs: 20 };
    const { modules: sendModules } = load(sendState);
    const akto = sendModules('aktoClient.js');
    const msg = (i) => ({ requestHeaders: JSON.stringify({ 'X-Request-Id': `m${i}` }), requestPayload: 'x' });
    restore = quiet();
    let started = Date.now();
    let sent = await akto.sendToDataIngestionService(Array.from({ length: 20 }, (_, i) => msg(i)), () => 800000);
    let elapsed = Date.now() - started;
    restore();
    check('every message is sent, one per request', () => {
        assert.strictEqual(sent.sent, 20);
        assert.ok(sendState.posts.every((n) => n === 1));
    });
    check('10 requests are in flight at once by default', () => assert.strictEqual(sendState.maxInFlight, 10));
    check('so 20 messages take ~2 round trips, not 20', () => assert.ok(elapsed < 20 * 20 * 0.4, `${elapsed}ms`));

    const seq = { fetchDelayMs: 5 };
    const seqAkto = load(seq, { SEND_CONCURRENCY: '1' }).modules('aktoClient.js');
    restore = quiet();
    await seqAkto.sendToDataIngestionService(Array.from({ length: 6 }, (_, i) => msg(i)), () => 800000);
    restore();
    check('SEND_CONCURRENCY=1 restores strictly sequential sending', () => assert.strictEqual(seq.maxInFlight, 1));

    await acheck('a transient failure stops new requests and fails the send', async () => {
        const failing = { fetchDelayMs: 5, failPlan: (ids) => (ids.includes('m3') ? { status: 503, body: 'down' } : null) };
        const failingAkto = load(failing).modules('aktoClient.js');
        const r = quiet();
        let threw = null;
        try { await failingAkto.sendToDataIngestionService(Array.from({ length: 40 }, (_, i) => msg(i)), () => 800000); }
        catch (e) { threw = e; }
        r();
        assert.ok(threw, 'a transient failure was swallowed — the checkpoint would advance past unsent data');
        assert.ok(failing.posts.length < 40 + 3, `${failing.posts.length} POSTs — new batches kept starting after the failure`);
    });

    done();
})();
