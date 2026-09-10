/**
 * Shared stubs for the pipeline tests.
 *
 * Every suite needs the same thing: the real modules, with only S3, the Bedrock/IAM
 * APIs and fetch replaced. Doing that once here keeps each suite about its own
 * behaviour instead of 60 lines of setup — and means a change to the module layout
 * is fixed in one place.
 */
const path = require('path');
const zlib = require('zlib');
const { Readable } = require('stream');

const LAMBDA = path.join(__dirname, '..');

/** An AWS SDK error, which the code distinguishes by `name` rather than message. */
const awsError = (name, message = name) => Object.assign(new Error(message), { name });

/** One Bedrock model-invocation log entry, with an extractable exchange by default. */
function logEntry(overrides = {}) {
    const { i = 0, arn = 'arn:aws:sts::1:assumed-role/app-role/session',
        question = `question ${i}`, answer = `a long enough answer ${i}`,
        operation = 'Converse', modelId = 'anthropic.claude-v2', messages, output } = overrides;
    return {
        schemaType: 'ModelInvocationLog', operation, modelId,
        timestamp: new Date(Date.now() - 3600e3 + i * 1000).toISOString(),
        requestId: overrides.requestId || `req-${i}`,
        accountId: '1', region: 'us-east-1',
        identity: { arn },
        input: { inputBodyJson: messages ? { messages } : { messages: [{ role: 'user', content: [{ text: question }] }] }, inputTokenCount: 10 },
        output: output !== undefined ? output
            : { outputBodyJson: { output: { message: { role: 'assistant', content: [{ text: answer }] } } }, outputTokenCount: 10 }
    };
}

/**
 * Loads the pipeline with stubbed edges.
 *
 * `state` is mutated by the caller between runs to drive a scenario:
 *   files          — what ListObjectsV2 returns
 *   manifest       — the stored manifest body, or null for "no manifest yet"
 *   entriesFor(key)— the log entries a given S3 object contains
 *   failPlan(ids)  — given the requestIds in a POST, return {status, body} to fail it
 *   posts          — populated with each POST's message count
 *   traceManifest  — the AgentCore manifest body, or null
 *   logGroups      — what DescribeLogGroups returns
 */
function load(state, env = {}) {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(LAMBDA) && !key.includes(`${path.sep}test${path.sep}`)) delete require.cache[key];
    }
    Object.assign(process.env, {
        DATA_INGESTION_ENDPOINT: 'https://stub.akto.io/api/ingestData', AKTO_API_KEY: 'k',
        LOGS_BUCKET_NAME: 'b', LOGS_PREFIX: 'p/', MARKERS_BUCKET_NAME: 'm',
        BEDROCK_AWS_REGION: 'us-east-1', AWS_ACCOUNT_ID: '1',
        // Cleared every load: process.env persists, so a value tuned by one scenario
        // would silently leak into the next.
        SEND_BATCH_SIZE: '', MAX_TRACE_BYTES: '', RUN_BUDGET_MS: '', S3_BUDGET_SHARE: '',
        SCHEDULE_INTERVAL_MS: '', INGEST_SERVICE_AGENT_TRAFFIC: '',
        DEPLOYMENT_MODE: '', BEDROCK_LOGGING_MODE: '', BEDROCK_BUCKET_BASE_NAME: '', ...env
    });

    state.posts = [];
    state.awsCalls = {};
    const count = (name) => { state.awsCalls[name] = (state.awsCalls[name] || 0) + 1; };

    const s3Client = { async send(command) {
        const type = command.constructor.name;
        count(type);
        if (type === 'ListObjectsV2Command') return { Contents: state.files || [] };
        if (type === 'PutObjectCommand') {
            if (String(command.input.Key).includes('agentcore-tracing')) state.traceManifest = command.input.Body;
            else state.manifest = command.input.Body;
            return {};
        }
        if (type === 'GetObjectCommand') {
            const key = command.input.Key;
            if (key.includes('agentcore-tracing')) {
                if (state.traceManifest == null) throw awsError('NoSuchKey');
                return { Body: Readable.from([Buffer.from(state.traceManifest)]) };
            }
            if (key.endsWith('manifest.json')) {
                if (state.manifest == null) throw awsError('NoSuchKey');
                return { Body: Readable.from([Buffer.from(state.manifest)]) };
            }
            if (state.fileDelayMs) await new Promise((r) => setTimeout(r, state.fileDelayMs));
            const entries = state.entriesFor ? state.entriesFor(key) : [logEntry({ i: 0 })];
            const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
            return { Body: Readable.from([zlib.gzipSync(Buffer.from(body))]) };
        }
        // Bucket provisioning, reached only by bedrockDelivery.js in 'create' mode.
        // GetBucketPolicy raises NoSuchBucketPolicy by default so the policy merge takes
        // its "nothing to merge with" path; set state.bucketPolicy to exercise the merge.
        if (type === 'CreateBucketCommand') {
            if (state.createBucketError) throw awsError(state.createBucketError);
            return {};
        }
        if (type === 'GetBucketPolicyCommand') {
            if (!state.bucketPolicy) throw awsError('NoSuchBucketPolicy');
            return { Policy: state.bucketPolicy };
        }
        if (type === 'PutBucketPolicyCommand') {
            state.putBucketPolicy = command.input.Policy;
            return {};
        }
        throw new Error(`unstubbed S3 command: ${type}`);
    } };

    const bedrockAgentClient = { async send(command) {
        const type = command.constructor.name;
        count(type);
        if (type === 'ListAgentsCommand') return { agentSummaries: state.agents || [] };
        if (type === 'ListTagsForResourceCommand') return { tags: state.tags || {} };
        if (type === 'GetAgentCommand') return { agent: state.agentMetadata || {} };
        return {};
    } };
    const agentCoreClient = { async send(command) {
        const type = command.constructor.name;
        count(type);
        if (type === 'ListHarnessesCommand') return { harnesses: [] };
        if (type === 'ListAgentRuntimesCommand') return { agentRuntimes: [] };
        return {};
    } };
    const cloudWatchLogsClient = { async send(command) {
        const type = command.constructor.name;
        count(type);
        if (type === 'DescribeLogGroupsCommand') return { logGroups: state.logGroups || [] };
        if (type === 'FilterLogEventsCommand') {
            if (state.groupDelayMs) await new Promise((r) => setTimeout(r, state.groupDelayMs));
            return { events: state.logEvents || [] };
        }
        return {};
    } };
    const iamClient = { async send(command) {
        count(command.constructor.name);
        return { AttachedPolicies: state.policies || [] };
    } };

    /*
     * Bedrock control plane, used only to resolve where this account's model invocation
     * logs live. state.loggingConfig drives which of the four account states is being
     * exercised: an object is returned as-is, the string 'NOTFOUND' raises the same
     * exception an account that never enabled logging gets, and the default is an S3
     * configuration pointing at the bucket the rest of the harness already serves.
     */
    const bedrockClient = { async send(command) {
        const type = command.constructor.name;
        count(type);
        if (type === 'GetModelInvocationLoggingConfigurationCommand') {
            if (state.loggingConfig === 'NOTFOUND') throw awsError('ResourceNotFoundException');
            if (state.loggingConfig) return { loggingConfig: state.loggingConfig };
            return { loggingConfig: { s3Config: { bucketName: 'b', keyPrefix: '' } } };
        }
        return {};
    } };

    const configPath = path.join(LAMBDA, 'config.js');
    const real = require(configPath);
    require.cache[configPath].exports = {
        ...real, s3Client, bedrockClient, bedrockAgentClient, bedrockAgentCoreControlClient: agentCoreClient,
        cloudWatchLogsClient, iamClient
    };

    global.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        state.posts.push(body.batchData.length);
        const ids = body.batchData.map((m) => {
            try { return JSON.parse(m.requestHeaders)['X-Request-Id']; } catch { return ''; }
        });
        const plan = state.failPlan ? state.failPlan(ids) : null;
        if (plan) return { ok: false, status: plan.status, text: async () => plan.body, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };

    return {
        handler: require(path.join(LAMBDA, 'index.js')).handler,
        config: require.cache[configPath].exports,
        modules: (name) => require(path.join(LAMBDA, name))
    };
}

/** S3 objects, oldest first. LastModified is relative to now so the lookback accepts them. */
const mkFiles = (n, prefix = 'p/f') => Array.from({ length: n }, (_, i) => ({
    Key: `${prefix}${i}.json.gz`, LastModified: new Date(Date.now() - 3600e3 + i * 1000), Size: 9
}));

const mkGroups = (n) => Array.from({ length: n },
    (_, i) => ({ logGroupName: `/aws/bedrock-agentcore/runtimes/rt-${i}-DEFAULT` }));

/** Silences the pipeline's own logging; returns a restore function. */
function quiet() {
    const { log, warn, error } = console;
    console.log = console.warn = console.error = () => {};
    return () => Object.assign(console, { log, warn, error });
}

/** Runs the handler with plenty of Lambda time unless told otherwise. */
const invoke = (handler, msLeft = 800000) =>
    handler({ source: 'aws.events' }, { getRemainingTimeInMillis: () => msLeft });

module.exports = { LAMBDA, load, logEntry, mkFiles, mkGroups, quiet, invoke, awsError };
