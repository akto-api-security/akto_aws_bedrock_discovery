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

/** The dated folder Bedrock writes to for `account`/`region` at time `ms` (UTC). */
const pad = (n) => String(n).padStart(2, '0');
function bedrockFolder(account, region, ms = Date.now() - 30 * 60e3) {
    const d = new Date(ms);
    return `AWSLogs/${account}/BedrockModelInvocationLogs/${region}/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}/`;
}
const OWN = '111122223333';

/**
 * Single mode reads the configured prefix ('p/' in the harness); stackset mode reads the
 * prefix discovered from the logging configuration ('AWSLogs/'), so its files sit where
 * Bedrock really writes them.
 */
function fresh(extra = {}) {
    return { manifest: null, traceManifest: null, files: mkFiles(3), entriesFor: () => [logEntry({ i: 0 })], failPlan: () => null, ...extra };
}
const freshStackset = (extra = {}) => fresh({ files: mkFiles(3, `${bedrockFolder(OWN, 'eu-west-1')}f`), ...extra });

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
        const state = freshStackset();
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
        await acheck('the run lock sits under <account>/<region>/ too', async () => {
            assert.ok(state.lock, 'no lock written');
            assert.strictEqual(state.lockKey, '111122223333/eu-west-1/bedrock-logs/run-lock.json');
        });
    }

    section('stackset mode: a bucket shared by several accounts and regions');
    {
        // One organization bucket: this account in two regions, plus another account.
        // The role may only read its own account's keys, and this stack instance runs
        // for eu-west-1 — so only those files are read.
        const files = [
            ...mkFiles(3, `${bedrockFolder(OWN, 'eu-west-1')}own-`),
            ...mkFiles(2, `${bedrockFolder(OWN, 'us-east-1')}other-region-`),
            ...mkFiles(4, `${bedrockFolder('999988887777', 'eu-west-1')}other-account-`)
        ];
        const read = [];
        const state = fresh({ files, entriesFor: (key) => { read.push(key); return [logEntry({ i: 0 })]; } });
        const { body } = await run(state, STACKSET);
        await acheck('only this account\'s files for this region are read', async () => {
            assert.strictEqual(body.s3.filesDone, 3, read.join(', '));
            assert.ok(read.every((k) => k.includes(`/${OWN}/`) && k.includes('/eu-west-1/')), read.join(', '));
        });
        await acheck('another account\'s logs never fail as unreadable', async () => assert.strictEqual(body.s3.filesFailed, 0));
    }
    {
        // This account logs only from another region's folder: kept rather than dropped,
        // so a layout this code does not expect still reads the account's own logs.
        const read = [];
        const state = fresh({
            files: mkFiles(2, `${bedrockFolder(OWN, 'us-east-1')}f`),
            entriesFor: (key) => { read.push(key); return [logEntry({ i: 0 })]; }
        });
        const { body } = await run(state, STACKSET);
        await acheck('with no folder for this region, the account\'s other folders are still read', async () => {
            assert.strictEqual(body.s3.filesDone, 2, read.join(', '));
        });
    }
    {
        // No dated folders at all: the full-listing fallback applies the same account rule.
        const read = [];
        const state = fresh({
            files: [...mkFiles(2, `AWSLogs/${OWN}/flat-`), ...mkFiles(3, 'AWSLogs/999988887777/flat-')],
            entriesFor: (key) => { read.push(key); return [logEntry({ i: 0 })]; }
        });
        const { body } = await run(state, STACKSET);
        await acheck('the full-listing fallback also reads only this account\'s files', async () => {
            assert.strictEqual(body.s3.filesDone, 2, read.join(', '));
            assert.strictEqual(body.s3.filesFailed, 0);
        });
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
