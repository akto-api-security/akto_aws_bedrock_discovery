const { parse } = require('@aws-sdk/util-arn-parser');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { BedrockClient, GetModelInvocationLoggingConfigurationCommand } = require('@aws-sdk/client-bedrock');
const { BedrockAgentClient, ListAgentsCommand } = require('@aws-sdk/client-bedrock-agent');
const { BedrockAgentCoreControlClient, ListHarnessesCommand, ListAgentRuntimesCommand } = require('@aws-sdk/client-bedrock-agentcore-control');

const REGIONS = [
    'us-east-1', 'us-east-2', 'us-west-2', 'eu-west-1', 'eu-west-2', 'eu-west-3',
    'eu-central-1', 'eu-north-1', 'ap-south-1', 'ap-south-2', 'ap-southeast-1',
    'ap-southeast-2', 'ap-northeast-1', 'ap-northeast-2', 'ca-central-1', 'sa-east-1'
];

async function assumeRole(roleArn, externalId) {
    const response = await new STSClient({}).send(new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: 'akto-hub-discover',
        ExternalId: externalId
    }));
    return {
        accessKeyId: response.Credentials.AccessKeyId,
        secretAccessKey: response.Credentials.SecretAccessKey,
        sessionToken: response.Credentials.SessionToken
    };
}

async function regionActivity(credentials, region) {
    const opts = { region, credentials };
    let logsBucket = '';
    let logsPrefix = 'AWSLogs/';

    try {
        const cfg = await new BedrockClient(opts).send(new GetModelInvocationLoggingConfigurationCommand({}));
        logsBucket = cfg.loggingConfig?.s3Config?.bucketName || '';
        logsPrefix = cfg.loggingConfig?.s3Config?.keyPrefix || logsPrefix;
    } catch { /* unsupported or denied */ }

    let active = Boolean(logsBucket);
    try {
        const agents = await new BedrockAgentClient(opts).send(new ListAgentsCommand({}));
        active = active || (agents.agentSummaries || []).length > 0;
    } catch { /* */ }
    try {
        const core = new BedrockAgentCoreControlClient(opts);
        const harnesses = await core.send(new ListHarnessesCommand({}));
        const runtimes = await core.send(new ListAgentRuntimesCommand({}));
        active = active || (harnesses.harnesses || []).length > 0 || (runtimes.agentRuntimes || []).length > 0;
    } catch { /* */ }

    return { active, logsBucket, logsPrefix };
}

async function discoverTargets(roleArn, externalId) {
    const accountId = parse(roleArn).accountId;
    const credentials = await assumeRole(roleArn, externalId);
    const targets = [];

    for (const region of REGIONS) {
        const activity = await regionActivity(credentials, region);
        if (!activity.active || !activity.logsBucket) continue;
        targets.push({ roleArn, externalId, accountId, region, logsBucket: activity.logsBucket, logsPrefix: activity.logsPrefix });
    }
    return targets;
}

module.exports = { discoverTargets };
