/**
 * Which agent — or which caller — does a log entry belong to?
 *
 * The execution role answers it for almost all traffic. The STS session name, into
 * which Bedrock stamps the invoked agent's ID, is consulted only as a fallback when
 * several agents share one role. Traffic no agent owns becomes a SERVICE_AGENT named
 * after the calling principal rather than being dropped.
 */
const assert = require('assert');
const { load, quiet } = require('./harness');
const { section, check, done } = require('./assert-lite');

const ACCOUNT = '1';
const SHARED = 'AmazonBedrockExecutionRoleForAgents_SHARED';
const entry = (id, name, role = SHARED) => ({
    resourceId: id, resourceType: 'AGENT', resourceName: name,
    roleName: role, executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/${role}`
});
const arn = (session, role = SHARED) => `arn:aws:sts::${ACCOUNT}:assumed-role/${role}/${session}`;

const state = {};

(async () => {
    section('a shared role is narrowed by the session name');
    let { modules } = load(state);
    let discovery = modules('discovery.js');
    const four = {
        'agent-KYDT5XZQZW': entry('KYDT5XZQZW', 'august-agent'),
        'agent-ABC1234567': entry('ABC1234567', 'billing-agent'),
        'agent-XYZ9876543': entry('XYZ9876543', 'support-agent'),
        'agent-QWE4567890': entry('QWE4567890', 'ops-agent')
    };
    let restore = quiet();
    await discovery.rebuildRoleMapFromDiscoveredAgents(four, () => 800000);
    restore();

    check('each of the four resolves to its own agent', () => {
        const got = ['KYDT5XZQZW', 'ABC1234567', 'XYZ9876543', 'QWE4567890']
            .map((id) => discovery.findResourceByArn(arn(`BedrockAgents-${id}-30a9f552`)));
        assert.deepStrictEqual(got.map((r) => r && r.agentId), ['KYDT5XZQZW', 'ABC1234567', 'XYZ9876543', 'QWE4567890']);
        assert.deepStrictEqual(got.map((r) => r.agentName), ['august-agent', 'billing-agent', 'support-agent', 'ops-agent']);
    });
    check('counted as resolved-by-session, not by-role', () => {
        const s = discovery.getIdentityStats();
        assert.strictEqual(s.resolvedBySession, 4);
        assert.strictEqual(s.resolvedByRole, 0);
    });
    check('the agent id match is case-insensitive', () => {
        const r = discovery.findResourceByArn(arn('BedrockAgents-kydt5xzqzw-30a9f552'));
        assert.ok(r, 'a lowercase id was dropped');
        assert.strictEqual(r.agentId, 'KYDT5XZQZW');
    });
    check('a session naming an unknown agent is skipped, not guessed', () => {
        restore = quiet();
        const r = discovery.findResourceByArn(arn('BedrockAgents-BRANDNEW01-30a9f552'));
        restore();
        assert.strictEqual(r, null, 'attributed traffic to an agent it has no record of');
    });
    check('a shared role with no agent id in the session is skipped', () => {
        restore = quiet();
        const before = discovery.getIdentityStats().ambiguousSkips;
        assert.strictEqual(discovery.findResourceByArn(arn('plain-console-session')), null);
        restore();
        assert.strictEqual(discovery.getIdentityStats().ambiguousSkips, before + 1);
    });
    check('the ambiguity warning is logged once per role, not per entry', () => {
        const lines = [];
        const warn = console.warn;
        console.warn = (m) => lines.push(String(m));
        for (let i = 0; i < 20; i++) discovery.findResourceByArn(arn(`console-${i}`));
        console.warn = warn;
        assert.strictEqual(lines.length, 0, 'an already-reported role was logged again');
    });

    section('a role owned by exactly one agent');
    ({ modules } = load(state));
    discovery = modules('discovery.js');
    restore = quiet();
    await discovery.rebuildRoleMapFromDiscoveredAgents(
        { 'agent-SOLO111111': entry('SOLO111111', 'solo-agent', 'SoloRole') }, () => 800000);
    restore();
    check('the role alone is enough', () => {
        const r = discovery.findResourceByArn(arn('anything', 'SoloRole'));
        assert.strictEqual(r && r.agentId, 'SOLO111111');
        assert.strictEqual(discovery.getIdentityStats().resolvedByRole, 1);
    });
    check('a unique role wins even when the session names another agent', () => {
        // The map is the decision on a unique role; the session is not consulted.
        const r = discovery.findResourceByArn(arn('BedrockAgents-SOMEOTHER1-30a9', 'SoloRole'));
        assert.strictEqual(r.agentId, 'SOLO111111');
        assert.strictEqual(discovery.getIdentityStats().resolvedBySession, 0, 'the fallback ran on a unique role');
    });

    section('traffic no agent owns becomes a service agent');
    check('an unowned role is named after itself', () => {
        restore = quiet();
        const r = discovery.findResourceByArn(arn('user@example.com', 'SomeAppRole'));
        restore();
        assert.ok(r, 'direct model traffic was dropped');
        assert.strictEqual(r.type, 'SERVICE_AGENT');
        assert.strictEqual(r.callerName, 'SomeAppRole');
        assert.strictEqual(r.callerKind, 'IAM_ROLE');
    });
    check('an IAM user (a Bedrock API key) is named too', () => {
        restore = quiet();
        const r = discovery.findResourceByArn('arn:aws:iam::1:user/BedrockAPIKey-cxsw');
        restore();
        assert.strictEqual(r.callerName, 'BedrockAPIKey-cxsw');
        assert.strictEqual(r.callerKind, 'IAM_USER');
    });
    check('a non-ARN is dropped, not turned into a bot named after junk', () => {
        restore = quiet();
        assert.deepStrictEqual(['not-an-arn', '', null, undefined].map((v) => discovery.findResourceByArn(v)),
            [null, null, null, null]);
        restore();
    });

    section('principal parsing');
    const { parsePrincipal } = discovery;
    const cases = [
        ['arn:aws:sts::1:assumed-role/aria-usertask-role/de178ac9', 'aria-usertask-role', 'IAM_ROLE'],
        ['arn:aws:iam::1:user/BedrockAPIKey-cxsw', 'BedrockAPIKey-cxsw', 'IAM_USER'],
        ['arn:aws:iam::1:role/plain-role', 'plain-role', 'IAM_ROLE'],
        ['arn:aws:iam::1:user/path/to/Nested', 'Nested', 'IAM_USER'],
        ['arn:aws:iam::1:root', 'root', 'AWS_ROOT'],
        ['arn:aws:sts::1:federated-user/bob', 'bob', 'UNKNOWN']
    ];
    for (const [input, name, kind] of cases) {
        check(`${kind.padEnd(9)} ${input.slice(0, 46)}`, () => {
            const p = parsePrincipal(input);
            assert.strictEqual(p.name, name);
            assert.strictEqual(p.kind, kind);
        });
    }

    section('the role map is rebuilt from the manifest, not the API');
    let fresh = load(state);
    state.agentMetadata = { agentArn: 'arn:aws:bedrock:us-east-1:1:agent/LEGACY0001', agentResourceRoleArn: 'arn:aws:iam::1:role/BackfilledRole' };
    discovery = fresh.modules('discovery.js');
    restore = quiet();
    await discovery.rebuildRoleMapFromDiscoveredAgents(
        { a: entry('A1AAAAAAAA', 'a'), b: entry('B2BBBBBBBB', 'b'), c: entry('C3CCCCCCCC', 'c') }, () => 800000);
    restore();
    check('agents with a persisted role cost zero GetAgent calls', () =>
        assert.strictEqual(state.awsCalls.GetAgentCommand || 0, 0));

    fresh = load(state);
    discovery = fresh.modules('discovery.js');
    const legacy = { 'agent-LEGACY0001': { resourceId: 'LEGACY0001', resourceType: 'AGENT', resourceName: 'legacy' } };
    restore = quiet();
    await discovery.rebuildRoleMapFromDiscoveredAgents(legacy, () => 800000);
    restore();
    check('a legacy entry with no role is backfilled once and written back', () => {
        assert.strictEqual(state.awsCalls.GetAgentCommand, 1);
        assert.strictEqual(legacy['agent-LEGACY0001'].roleName, 'BackfilledRole');
    });
    check('and is then resolvable by that role', () =>
        assert.strictEqual(discovery.findResourceByArn(arn('s', 'BackfilledRole')).agentId, 'LEGACY0001'));

    fresh = load(state);
    discovery = fresh.modules('discovery.js');
    restore = quiet();
    await discovery.rebuildRoleMapFromDiscoveredAgents(
        { x: { resourceId: 'X1', resourceType: 'AGENT', resourceName: 'x' } }, () => 1000);
    restore();
    check('backfill defers rather than half-building the map when time is short', () =>
        assert.strictEqual(state.awsCalls.GetAgentCommand || 0, 0));

    section('per-run state');
    check('resetRunLogState zeroes the counters', () => {
        discovery.resetRunLogState();
        assert.deepStrictEqual(discovery.getIdentityStats(),
            { resolvedByRole: 0, resolvedBySession: 0, ambiguousSkips: 0, serviceAgentCallers: 0, noPrincipal: 0 });
    });

    done();
})();
