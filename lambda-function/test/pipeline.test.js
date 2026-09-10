/**
 * How one invocation divides its time.
 *
 * EventBridge fires on a timer whether or not the last run finished, and Lambda runs
 * overlapping invocations concurrently — two runs would read the same checkpoint and
 * send duplicates. A wall-clock budget shorter than the schedule removes that by
 * construction. Within the budget, S3 runs first but must not starve AgentCore, and
 * whatever one pipeline leaves unused goes to the other.
 */
const assert = require('assert');
const { load, logEntry, mkFiles, mkGroups, quiet, invoke } = require('./harness');
const { section, check, done } = require('./assert-lite');

const state = {
    entriesFor: (key) => [logEntry({ i: Number(String(key).match(/f(\d+)/)[1]) })],
    failPlan: () => null
};
const reset = () => { state.manifest = null; state.traceManifest = null; state.fileDelayMs = 0; state.groupDelayMs = 0; };

(async () => {
    section('the budget is derived from the schedule');
    let { config } = load(state, { SCHEDULE_INTERVAL_MS: '600000' });
    check('80% of a 10-minute schedule', () => assert.strictEqual(config.RUN_BUDGET_MS, 480000));
    check('S3 holds half of that', () => {
        assert.strictEqual(config.S3_BUDGET_SHARE, 0.5);
        assert.strictEqual(config.S3_BUDGET_MS, 240000);
    });
    ({ config } = load(state, { SCHEDULE_INTERVAL_MS: '900000' }));
    check('and it tracks a 15-minute schedule', () => assert.strictEqual(config.RUN_BUDGET_MS, 720000));

    section('S3 runs before AgentCore');
    reset();
    state.files = mkFiles(3);
    state.logGroups = mkGroups(2);
    let restore = quiet();
    let { handler } = load(state);
    let res = await invoke(handler);
    restore();
    let body = JSON.parse(res.body);
    check('both pipelines ran', () => {
        assert.ok(body.s3.filesDone > 0, 'S3 did nothing');
        assert.strictEqual(body.agentCore.logGroupsFound, 2);
    });
    check('the summary records the ordering', () => assert.strictEqual(body.pipelineOrder, 's3-then-agentcore'));

    section('the budget stops work with Lambda time to spare');
    reset();
    state.files = mkFiles(40);
    state.logGroups = [];
    state.fileDelayMs = 20;
    // No extractable exchange, so nothing is pending when the budget expires. That
    // keeps this about the budget rather than the send deadline (see below).
    state.entriesFor = (key) => [logEntry({ i: Number(String(key).match(/f(\d+)/)[1]), output: {} })];
    restore = quiet();
    ({ handler } = load(state, { RUN_BUDGET_MS: '300' }));
    res = await invoke(handler);
    restore();
    body = JSON.parse(res.body);
    check('it stops well short of all 40 files', () => assert.ok(body.s3.filesDone < 40, `read all ${body.s3.filesDone}`));
    check('the remainder is deferred, not dropped', () => assert.ok(body.s3.filesDeferred > 0));
    check('plenty of Lambda time was still available', () => assert.ok(body.lambdaTimeLeftMs > 700000));
    check('progress is still checkpointed before stopping', () => assert.ok(state.manifest, 'no checkpoint'));

    section('a large S3 backlog cannot starve AgentCore');
    reset();
    state.files = mkFiles(500);
    state.entriesFor = (key) => [logEntry({ i: Number(String(key).match(/f(\d+)/)[1]), output: {} })];
    state.logGroups = mkGroups(3);
    state.fileDelayMs = 20;
    restore = quiet();
    ({ handler } = load(state, { RUN_BUDGET_MS: '1500' }));
    res = await invoke(handler);
    restore();
    body = JSON.parse(res.body);
    check('S3 hands over at its share', () => {
        assert.ok(body.s3HandoverMs >= body.s3BudgetMs * 0.5,
            `handed over at ${body.s3HandoverMs}ms of a ${body.s3BudgetMs}ms share`);
        assert.ok(body.s3HandoverMs < body.runBudgetMs, 'S3 ran past the whole budget');
    });
    check('AgentCore still gets to process, not just list', () =>
        assert.ok(body.agentCore.groupsProcessed > 0, 'AgentCore was starved'));

    section('unused time is not forfeited');
    reset();
    state.files = [];
    state.logGroups = mkGroups(3);
    state.groupDelayMs = 60;
    restore = quiet();
    ({ handler } = load(state, { RUN_BUDGET_MS: '1500' }));
    res = await invoke(handler);
    restore();
    body = JSON.parse(res.body);
    check('with no S3 work the handover is immediate', () =>
        assert.ok(body.s3HandoverMs < body.s3BudgetMs, `handover took ${body.s3HandoverMs}ms`));
    check('AgentCore processes every group with the freed time', () => {
        assert.strictEqual(body.agentCore.groupsProcessed, 3);
        assert.strictEqual(body.agentCore.groupsDeferred, 0);
    });

    section('a classic-only account gets the whole budget');
    reset();
    state.files = mkFiles(500);
    state.entriesFor = (key) => [logEntry({ i: Number(String(key).match(/f(\d+)/)[1]), output: {} })];
    state.logGroups = [];               // AgentCore idle, as in a classic-only account
    state.fileDelayMs = 20;
    restore = quiet();
    ({ handler } = load(state, { RUN_BUDGET_MS: '2000' }));
    const startedAt = Date.now();
    res = await invoke(handler);
    const wall = Date.now() - startedAt;
    restore();
    body = JSON.parse(res.body);
    check('S3 still has a backlog, so the test is meaningful', () => assert.ok(body.s3.filesDeferred > 0));
    check('AgentCore genuinely had nothing to do', () => assert.strictEqual(body.agentCore.logGroupsFound, 0));
    check('the run uses its whole budget rather than stopping at the share', () => {
        const unused = body.runBudgetMs - wall;
        assert.ok(unused < body.runBudgetMs * 0.15,
            `${unused}ms of ${body.runBudgetMs}ms went unused while ${body.s3.filesDeferred} file(s) waited`);
    });
    check('a second S3 pass ran to reclaim it', () => assert.ok(body.s3.secondPass, 'no second pass'));
    check('its work is added, not substituted', () =>
        assert.ok(body.s3.filesDone > body.s3.secondPass.filesDone, 'the first pass was lost'));
    check('traffic counters cover both passes, not just the last', () => {
        const t = body.s3.traffic;
        const seen = t.agentCalls + t.serviceAgentIngested + t.serviceAgentCalls + t.noIdentity;
        assert.strictEqual(seen, body.s3.filesDone,
            `${seen} entries counted for ${body.s3.filesDone} files — the first pass's stats were overwritten`);
    });


    section('a clock-stopped run still delivers what it read');
    // Was a permanent stall: the budget reports 0 the moment it expires, the send
    // inherited that clock and refused to start, so nothing was checkpointed and the
    // next run repeated it. Sending now runs on the Lambda clock instead.
    reset();
    state.files = mkFiles(300);
    state.logGroups = [];
    state.fileDelayMs = 8;
    // Most files log no response body, as ~75% of real client traffic does — so the
    // run builds far fewer than FLUSH_THRESHOLD messages and has no earlier flush to
    // fall back on.
    state.entriesFor = (key) => {
        const i = Number(String(key).match(/f(\d+)/)[1]);
        return [i % 40 === 0 ? logEntry({ i }) : logEntry({ i, output: {} })];
    };
    restore = quiet();
    ({ handler } = load(state, { RUN_BUDGET_MS: '1200' }));
    res = await invoke(handler);
    restore();
    body = JSON.parse(res.body);

    check('the run succeeds instead of throwing on the deadline', () =>
        assert.strictEqual(res.statusCode, 200, JSON.parse(res.body).error || ''));
    check('the clock, not the file list, stopped it', () => assert.ok(body.s3.filesDeferred > 0));
    check('the messages it built are delivered', () => {
        assert.ok(body.s3.totalSent > 0, 'read files but sent nothing — the stall is back');
        assert.strictEqual(state.posts.length, body.s3.totalSent);
    });
    check('and the checkpoint advances, so the next run moves on', () => assert.ok(state.manifest, 'no checkpoint'));

    section('successive runs drain a backlog');
    const drained = [];
    for (let run = 0; run < 3; run++) {
        state.traceManifest = null;
        restore = quiet();
        ({ handler } = load(state, { RUN_BUDGET_MS: '1200' }));
        res = await invoke(handler);
        restore();
        drained.push(JSON.parse(res.body).s3.filesDone);
    }
    check('each run reads new files rather than repeating', () => {
        assert.ok(drained.every((n) => n >= 0), `progress: ${drained}`);
        assert.ok(drained.reduce((a, b) => a + b, 0) > 0, `no progress at all across 3 runs: ${drained}`);
    });
    check('the backlog is exhausted rather than looping', () => {
        assert.strictEqual(drained[drained.length - 1], 0,
            `still reading after 3 runs (${drained}) — the checkpoint is not advancing`);
    });

    done();
})();
