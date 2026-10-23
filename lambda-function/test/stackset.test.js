/**
 * StackSet deployment: one processor per account and region, one shared markers bucket.
 *
 * What must hold:
 *   - single-account mode is untouched: same checkpoint paths, the configured bucket,
 *     and no call to the Bedrock logging API at all
 *   - stackset mode keys every checkpoint by <account>/<region>/, so accounts sharing
 *     the bucket never overwrite each other
 *   - the logs bucket is read off the account's own logging configuration
 *   - an account logging only to CloudWatch is never modified, in either mode
 *   - 'create' mode provisions only when nothing at all is configured
 */
const assert = require('assert');
const { load, logEntry, mkFiles, quiet, invoke } = require('./harness');
const { section, acheck, done } = require('./assert-lite');

const STACKSET = { DEPLOYMENT_MODE: 'stackset', LOGS_BUCKET_NAME: '', AWS_ACCOUNT_ID: '111122223333', BEDROCK_AWS_REGION: 'eu-west-1' };

function fresh(extra = {}) {
    return { manifest: null, traceManifest: null, files: mkFiles(3), entriesFor: () => [logEntry({ i: 0 })], failPlan: () => null, ...extra };
}

async function run(state, env) {
    const restore = quiet();
    try {
        const { handler } = load(state, env);
        const res = await invoke(handler);
        return { res, body: JSON.parse(res.body) };
    } finally {
        restore();
    }
}

(async () => {
    section('single-account mode is unchanged');
    {
        const state = fresh();
        const { body } = await run(state);
        await acheck('reads the configured bucket and processes its files', async () => assert.strictEqual(body.s3.filesDone, 3));
        await acheck('checkpoint stays at akto/markers/bedrock-logs/', async () => {
            assert.ok(state.putKeys.includes('akto/markers/bedrock-logs/manifest.json'), state.putKeys.join(', '));
        });
        await acheck('never calls the Bedrock logging API', async () => {
            assert.strictEqual(state.awsCalls.GetModelInvocationLoggingConfigurationCommand, undefined);
        });
    }

    section('stackset mode: checkpoints keyed by account and region');
    {
        const state = fresh();
        const { res, body } = await run(state, STACKSET);
        await acheck('logs bucket is discovered from the logging configuration', async () => {
            assert.strictEqual(state.awsCalls.GetModelInvocationLoggingConfigurationCommand, 1);
            assert.strictEqual(body.s3.filesDone, 3);
        });
        await acheck('S3 manifest is written under <account>/<region>/', async () => {
            assert.ok(state.putKeys.includes('111122223333/eu-west-1/bedrock-logs/manifest.json'), state.putKeys.join(', '));
        });
        await acheck('nothing is written under the single-account path', async () => {
            assert.ok(!state.putKeys.some((k) => k.startsWith('akto/markers/')), state.putKeys.join(', '));
        });
        await acheck('LOGS_BUCKET_NAME is not required', async () => assert.strictEqual(res.statusCode, 200));
    }

    section('stackset mode: account logging only to CloudWatch');
    {
        const state = fresh({ loggingConfig: { cloudWatchConfig: { logGroupName: '/their/group', roleArn: 'arn:aws:iam::1:role/r' } } });
        const { body } = await run(state, { ...STACKSET, BEDROCK_LOGGING_MODE: 'create', BEDROCK_BUCKET_BASE_NAME: 'akto-logs' });
        await acheck('S3 processing is skipped, not failed', async () => assert.strictEqual(body.s3.filesDone, 0));
        await acheck('their configuration is never written, even in create mode', async () => {
            assert.strictEqual(state.awsCalls.PutModelInvocationLoggingConfigurationCommand, undefined);
            assert.strictEqual(state.awsCalls.CreateBucketCommand, undefined);
        });
    }

    section('stackset mode: nothing configured');
    {
        const state = fresh({ loggingConfig: 'NOTFOUND' });
        const { body } = await run(state, STACKSET);
        await acheck('discover mode reports and skips', async () => {
            assert.strictEqual(body.s3.filesDone, 0);
            assert.strictEqual(state.awsCalls.CreateBucketCommand, undefined);
        });
    }
    {
        const state = fresh({ loggingConfig: 'NOTFOUND' });
        await run(state, { ...STACKSET, BEDROCK_LOGGING_MODE: 'create', BEDROCK_BUCKET_BASE_NAME: 'akto-logs' });
        await acheck('create mode makes <base>-<account>-<region> and grants Bedrock write access', async () => {
            assert.strictEqual(state.awsCalls.CreateBucketCommand, 1);
            const policy = JSON.parse(state.putBucketPolicy);
            assert.ok(policy.Statement.some((s) => s.Resource === 'arn:aws:s3:::akto-logs-111122223333-eu-west-1/AWSLogs/111122223333/*'));
        });
        await acheck('enables S3 logging, text only', async () => {
            assert.strictEqual(state.putLoggingConfig.s3Config.bucketName, 'akto-logs-111122223333-eu-west-1');
            assert.strictEqual(state.putLoggingConfig.textDataDeliveryEnabled, true);
            assert.strictEqual(state.putLoggingConfig.imageDataDeliveryEnabled, false);
        });
    }

    section('stackset mode: key prefix in the logging configuration');
    {
        const state = fresh({ loggingConfig: { s3Config: { bucketName: 'their-bucket', keyPrefix: 'bedrock/' } } });
        const { modules } = (() => { const r = quiet(); try { return load(state, STACKSET); } finally { r(); } })();
        const location = await modules('bedrockDelivery.js').resolveBedrockLogLocation();
        await acheck('lists under <keyPrefix>/AWSLogs/ in their bucket', async () => {
            assert.deepStrictEqual({ bucket: location.bucket, prefix: location.prefix }, { bucket: 'their-bucket', prefix: 'bedrock/AWSLogs/' });
        });
    }

    section('configuration errors fail fast');
    {
        const state = fresh();
        const { res, body } = await run(state, { ...STACKSET, BEDROCK_LOGGING_MODE: 'create' });
        await acheck('create mode without BEDROCK_BUCKET_BASE_NAME is rejected before touching AWS', async () => {
            assert.strictEqual(res.statusCode, 500);
            assert.match(body.error, /BEDROCK_BUCKET_BASE_NAME/);
            assert.strictEqual(state.awsCalls.GetModelInvocationLoggingConfigurationCommand, undefined);
        });
    }

    done();
})();
