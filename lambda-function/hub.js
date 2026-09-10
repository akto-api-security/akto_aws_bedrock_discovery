/**
 * Entry point for cross-account deploys. Assumes the customer's role(s),
 * finds every account/region with Bedrock activity, runs the processor for each.
 */
const { discoverTargets } = require('./hubDiscover');

const LAMBDA_ROOT = __dirname;
const HUB_REGION = process.env.HUB_AWS_REGION || process.env.AWS_REGION;
const EXTERNAL_ID = process.env.CROSS_ACCOUNT_EXTERNAL_ID || '';

function parseRoleArns() {
    return String(process.env.CROSS_ACCOUNT_ROLE_ARNS || '')
        .split(',')
        .map((arn) => arn.trim())
        .filter(Boolean);
}

function clearProcessorModules() {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(LAMBDA_ROOT)) delete require.cache[key];
    }
}

function applyTargetEnv(target) {
    process.env.HUB_AWS_REGION = HUB_REGION;
    process.env.CROSS_ACCOUNT_ROLE_ARN = target.roleArn;
    process.env.CROSS_ACCOUNT_EXTERNAL_ID = target.externalId;
    process.env.AWS_ACCOUNT_ID = target.accountId;
    process.env.BEDROCK_AWS_REGION = target.region;
    process.env.AWS_REGION = HUB_REGION;
    process.env.LOGS_BUCKET_NAME = target.logsBucket;
    process.env.LOGS_PREFIX = target.logsPrefix;
    process.env.MARKERS_PREFIX = `akto/markers/${target.accountId}/${target.region}/`;
}

function mockContext() {
    const deadline = Date.now() + 14 * 60 * 1000;
    return { getRemainingTimeInMillis: () => Math.max(0, deadline - Date.now()) };
}

exports.handler = async () => {
    const roleArns = parseRoleArns();
    if (!EXTERNAL_ID) throw new Error('CROSS_ACCOUNT_EXTERNAL_ID is required');
    if (roleArns.length === 0) throw new Error('CROSS_ACCOUNT_ROLE_ARNS is required');

    const results = [];
    for (const roleArn of roleArns) {
        const targets = await discoverTargets(roleArn, EXTERNAL_ID);
        for (const target of targets) {
            console.log(`▶️ ${target.accountId} / ${target.region}`);
            applyTargetEnv(target);
            clearProcessorModules();
            const { handler } = require('./index');
            await handler({ source: 'cross-account' }, mockContext());
            results.push({ accountId: target.accountId, region: target.region });
        }
    }
    return { regionsProcessed: results.length, results };
};
