/**
 * AKTO's wire format.
 *
 * AKTO admits traffic on two fields — tag.source must be AWS_BEDROCK and tag['bot-name']
 * must be non-empty. A message failing either is accepted by the ingest API, stored,
 * and then never appears in the dashboard: the worst failure mode, because every log
 * line says success.
 */
const assert = require('assert');
const { load, quiet } = require('./harness');
const { section, check, done } = require('./assert-lite');

const state = {};
const { buildAgentMessage } = load(state).modules('messageBuilder.js');

const ARN = 'arn:aws:sts::1:assumed-role/aria-usertask-role/de178ac9';
const base = {
    timestamp: '2026-08-12T09:00:00Z', requestId: 'req-1', modelId: 'amazon.nova-lite-v1:0',
    arn: ARN, operation: 'Converse', accountId: '1', region: 'us-east-1',
    userMessage: 'the question', agentResponse: 'a reply long enough to survive filtering',
    inputTokenCount: 11, outputTokenCount: 22, agentTags: {}, harnessTags: {}, awsMetadata: {}
};
const tagOf = (m) => JSON.parse(m.tag);

(async () => {
    section('the envelope');
    const agent = buildAgentMessage({ ...base, logType: 'AGENT', agentId: 'A1', botName: 'my-agent' }, true);
    check('the path mirrors the real Runtime API', () =>
        assert.strictEqual(agent.path, '/model/amazon.nova-lite-v1:0/converse'));
    check('an operation maps to its path suffix', () => {
        const streamed = buildAgentMessage({ ...base, operation: 'ConverseStream', logType: 'AGENT', agentId: 'A1', botName: 'a' }, true);
        assert.ok(streamed.path.endsWith('/converse-stream'));
    });
    check('a model ARN goes into the path verbatim', () => {
        // AWS documents inference-profile ARNs appearing in this position, so the
        // recorded endpoint should be the endpoint that was actually called.
        const arnModel = 'arn:aws:bedrock:us-east-1:1:inference-profile/us.anthropic.claude-opus-5';
        const m = buildAgentMessage({ ...base, modelId: arnModel, logType: 'AGENT', agentId: 'A1', botName: 'a' }, true);
        assert.strictEqual(m.path, `/model/${arnModel}/converse`);
    });
    check('nested fields are JSON strings, as on the wire', () => {
        for (const k of ['requestHeaders', 'responseHeaders', 'requestPayload', 'responsePayload', 'tag']) {
            assert.strictEqual(typeof agent[k], 'string', `${k} is not a string`);
            JSON.parse(agent[k]);
        }
    });
    check('the timestamp comes from the log entry, not from now', () =>
        assert.strictEqual(agent.time, String(Math.floor(new Date(base.timestamp).getTime() / 1000))));

    section('the two fields AKTO admits on');
    const shapes = [
        ['agent, name resolved', { logType: 'AGENT', agentId: 'A1', botName: 'my-agent' }],
        ['service agent (role)', { logType: 'SERVICE_AGENT', agentId: 'aria-usertask-role', botName: 'aria-usertask-role', callerKind: 'IAM_ROLE' }],
        ['service agent (user)', { logType: 'SERVICE_AGENT', agentId: 'BedrockAPIKey-cxsw', botName: 'BedrockAPIKey-cxsw', callerKind: 'IAM_USER' }]
    ];
    for (const [name, extra] of shapes) {
        check(`${name}: source and bot-name both set`, () => {
            const tag = tagOf(buildAgentMessage({ ...base, ...extra }, true));
            assert.strictEqual(tag.source, 'AWS_BEDROCK');
            assert.ok(tag['bot-name'] && String(tag['bot-name']).trim(), 'bot-name is empty — would be invisible');
        });
    }

    section('a service agent is presented as an agent');
    // s3Logs.js sets agentId and botName to the caller name for a service agent, so
    // it groups on the AKTO side exactly like a discovered agent.
    const svc = tagOf(buildAgentMessage({ ...base, logType: 'SERVICE_AGENT', agentId: 'aria-usertask-role', botName: 'aria-usertask-role', callerKind: 'IAM_ROLE' }, true));
    check('so it lands on the agent graph', () => assert.strictEqual(svc.agentType, 'BEDROCK_AGENT'));
    check('the caller name is both bot-name and agent-id', () =>
        assert.strictEqual(svc['bot-name'], svc['agent-id']));
    check('harness and runtime ids stay empty', () => {
        assert.strictEqual(svc['harness-id'], '');
        assert.strictEqual(svc['runtime-id'], '');
    });
    check('caller-kind records the principal type', () => assert.strictEqual(svc['caller-kind'], 'IAM_ROLE'));
    check('caller-kind is absent for a real agent', () => {
        assert.strictEqual(tagOf(buildAgentMessage({ ...base, logType: 'AGENT', agentId: 'A1', botName: 'a' }, true))['caller-kind'], undefined);
    });

    section('a real agent keeps its own identity');
    const withTags = tagOf(buildAgentMessage({
        ...base, logType: 'AGENT', agentId: 'A1', botName: 'my-agent',
        agentTags: { env: 'prod', 'bedrock-execution-role': 'MyRole', 'bedrock-role-policies': 'P1' }
    }, true));
    check('agent-id is the agent, not the role', () => assert.strictEqual(withTags['agent-id'], 'A1'));
    check('the customer\'s own resource tags survive', () => assert.strictEqual(withTags.env, 'prod'));
    check('execution-role enrichment is carried', () => {
        assert.strictEqual(withTags['bedrock-execution-role'], 'MyRole');
        assert.strictEqual(withTags['bedrock-role-policies'], 'P1');
    });

    section('the conversation payload carries no duplication');
    const payload = JSON.parse(agent.requestPayload);
    check('only the final user turn', () => {
        assert.strictEqual(payload.messages.length, 1);
        assert.strictEqual(payload.messages[0].role, 'user');
    });
    check('model and requestId are not repeated in the body', () => {
        // Both already travel in the path, the headers and the tag.
        assert.strictEqual(payload.model, undefined);
        assert.strictEqual(payload.requestId, undefined);
    });
    check('the request id is still recoverable from the headers', () =>
        assert.strictEqual(JSON.parse(agent.requestHeaders)['X-Request-Id'], 'req-1'));
    check('token usage is reported', () => {
        assert.deepStrictEqual(JSON.parse(agent.responsePayload).usage, { inputTokens: 11, outputTokens: 22 });
    });

    section('a discovery message');
    const disc = buildAgentMessage({ ...base, resourceType: 'AGENT', agentId: 'A2', agentName: 'found-agent', foundationModel: 'anthropic.claude-v2' }, false);
    check('is marked metadata-only', () => assert.strictEqual(tagOf(disc)['discovery-type'], 'METADATA_ONLY'));
    check('and describes the resource rather than a conversation', () => {
        const body = JSON.parse(disc.requestPayload);
        assert.strictEqual(body.resourceId, 'A2');
        assert.strictEqual(body.resourceType, 'AGENT');
        assert.strictEqual(body.messages, undefined, 'a discovery message must not look like a conversation');
    });

    done();
})();
