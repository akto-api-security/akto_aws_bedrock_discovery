/**
 * Shared configuration, tunables, and AWS SDK client instances.
 * Every other module in this function reads its settings from here.
 */
const { BedrockAgentClient } = require('@aws-sdk/client-bedrock-agent');
const { BedrockAgentCoreControlClient } = require('@aws-sdk/client-bedrock-agentcore-control');
const { CloudWatchLogsClient } = require('@aws-sdk/client-cloudwatch-logs');
const { IAMClient } = require('@aws-sdk/client-iam');
const { LambdaClient } = require('@aws-sdk/client-lambda');
const { S3Client } = require('@aws-sdk/client-s3');
const { STSClient, AssumeRoleCommand } = require('@aws-sdk/client-sts');

const CODE_VERSION = (() => {
    try {
        return require('fs').readFileSync(require('path').join(__dirname, 'VERSION'), 'utf-8').trim() || 'unknown';
    } catch {
        return 'unknown';
    }
})();

const DATA_INGESTION_ENDPOINT = process.env.DATA_INGESTION_ENDPOINT;
const AKTO_API_KEY = process.env.AKTO_API_KEY;
const LOGS_BUCKET_NAME = process.env.LOGS_BUCKET_NAME;
const LOGS_PREFIX = process.env.LOGS_PREFIX || 'AWSLogs/';
const MARKERS_BUCKET_NAME = process.env.MARKERS_BUCKET_NAME;
const AWS_REGION = process.env.BEDROCK_AWS_REGION || process.env.AWS_REGION;
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;
const CROSS_ACCOUNT_ROLE_ARN = process.env.CROSS_ACCOUNT_ROLE_ARN || '';
const CROSS_ACCOUNT_EXTERNAL_ID = process.env.CROSS_ACCOUNT_EXTERNAL_ID || '';
const MARKERS_S3_REGION = process.env.MARKERS_S3_REGION || process.env.AWS_REGION;

const MARKERS_PREFIX = (() => {
    const raw = process.env.MARKERS_PREFIX || 'akto/markers/';
    return raw.endsWith('/') ? raw : `${raw}/`;
})();
const MANIFEST_KEY = `${MARKERS_PREFIX}bedrock-logs/manifest.json`;

const SEND_BATCH_SIZE = Number(process.env.SEND_BATCH_SIZE || 1);
const MAX_BATCH_BYTES = 5 * 1024 * 1024;
const SEND_DEADLINE_MARGIN_MS = 15000;
const FLUSH_THRESHOLD = 100;
const TIME_SAFETY_MARGIN_MS = 90000;
const SCHEDULE_INTERVAL_MS = Number(process.env.SCHEDULE_INTERVAL_MS || 600000);
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || Math.floor(SCHEDULE_INTERVAL_MS * 0.8));
const S3_BUDGET_SHARE = Number(process.env.S3_BUDGET_SHARE || 0.5);
const S3_BUDGET_MS = Math.floor(RUN_BUDGET_MS * S3_BUDGET_SHARE);
const INGEST_SERVICE_AGENT_TRAFFIC = String(process.env.INGEST_SERVICE_AGENT_TRAFFIC || 'true').toLowerCase() !== 'false';
const MAX_TRACE_BYTES = Number(process.env.MAX_TRACE_BYTES || 64 * 1024);
const FETCH_TIMEOUT_MS = 25000;
const MAX_SEND_ATTEMPTS = 3;
const LOOKBACK_DAYS = 3;

const RUNTIME_LOG_GROUP_PREFIX = process.env.RUNTIME_LOG_GROUP_PREFIX || '/aws/bedrock-agentcore/runtimes/';
const MAX_LOG_EVENTS_PER_FETCH = 1000;
const TRACE_LOOKBACK_DAYS = 3;
const TRACE_MARKERS_PREFIX = `${MARKERS_PREFIX}agentcore-tracing/`;
const TRACE_MANIFEST_KEY = `${TRACE_MARKERS_PREFIX}manifest.json`;

const INTERCEPTOR_LAMBDA_ARN = process.env.INTERCEPTOR_LAMBDA_ARN || '';
const INTERCEPTION_POINTS = ['REQUEST', 'RESPONSE'];
const INCLUDE_GATEWAY_IDS = parseIdList(process.env.INCLUDE_GATEWAY_IDS);
const EXCLUDE_GATEWAY_IDS = parseIdList(process.env.EXCLUDE_GATEWAY_IDS);
const INTERCEPTOR_DRY_RUN = String(process.env.INTERCEPTOR_DRY_RUN || '').trim().toLowerCase() === 'true';
const GATEWAY_MARKERS_PREFIX = `${MARKERS_PREFIX}agentcore-gateways/`;
const GATEWAY_MANIFEST_KEY = `${GATEWAY_MARKERS_PREFIX}manifest.json`;
const GATEWAY_NAME_MAP_MAX_BYTES = 3000;

let clientsInitialized = false;
let bedrockAgentClient;
let bedrockAgentCoreControlClient;
let cloudWatchLogsClient;
let iamClient;
let s3Client;
let markersS3Client;
const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION });

function parseIdList(value) {
    return String(value || '').split(',').map((id) => id.trim()).filter(Boolean);
}

async function assumeCustomerRole() {
    const sts = new STSClient({});
    const params = {
        RoleArn: CROSS_ACCOUNT_ROLE_ARN,
        RoleSessionName: `akto-bedrock-${AWS_ACCOUNT_ID || 'discovery'}`
    };
    if (CROSS_ACCOUNT_EXTERNAL_ID) {
        params.ExternalId = CROSS_ACCOUNT_EXTERNAL_ID;
    }
    const response = await sts.send(new AssumeRoleCommand(params));
    return {
        accessKeyId: response.Credentials.AccessKeyId,
        secretAccessKey: response.Credentials.SecretAccessKey,
        sessionToken: response.Credentials.SessionToken,
        expiration: response.Credentials.Expiration
    };
}

/**
 * Builds regional SDK clients. In hub/cross-account mode the data-plane clients
 * use assumed customer credentials; markers always use the Lambda's own creds.
 */
async function initAwsClients() {
    if (clientsInitialized) return;

    markersS3Client = new S3Client({ region: MARKERS_S3_REGION });

    const dataRegion = AWS_REGION;
    const clientOptions = { region: dataRegion };
    if (CROSS_ACCOUNT_ROLE_ARN) {
        clientOptions.credentials = await assumeCustomerRole();
        console.log(`🔐 Assumed ${CROSS_ACCOUNT_ROLE_ARN} for data-plane APIs in ${dataRegion}`);
    }

    bedrockAgentClient = new BedrockAgentClient(clientOptions);
    bedrockAgentCoreControlClient = new BedrockAgentCoreControlClient(clientOptions);
    cloudWatchLogsClient = new CloudWatchLogsClient(clientOptions);
    iamClient = new IAMClient(clientOptions);
    s3Client = new S3Client(clientOptions);
    clientsInitialized = true;
}

function validateConfig() {
    const required = { LOGS_BUCKET_NAME, LOGS_PREFIX, MARKERS_BUCKET_NAME, DATA_INGESTION_ENDPOINT, AKTO_API_KEY };
    for (const [key, value] of Object.entries(required)) {
        if (!value || !String(value).trim()) throw new Error(`${key} environment variable is required`);
    }
    if (CROSS_ACCOUNT_ROLE_ARN && !CROSS_ACCOUNT_EXTERNAL_ID) {
        throw new Error('CROSS_ACCOUNT_EXTERNAL_ID is required when CROSS_ACCOUNT_ROLE_ARN is set');
    }
}

module.exports = {
    CODE_VERSION,
    DATA_INGESTION_ENDPOINT, AKTO_API_KEY, LOGS_BUCKET_NAME, LOGS_PREFIX, MARKERS_BUCKET_NAME,
    AWS_REGION, AWS_ACCOUNT_ID, MARKERS_PREFIX, MANIFEST_KEY,
    CROSS_ACCOUNT_ROLE_ARN, CROSS_ACCOUNT_EXTERNAL_ID, MARKERS_S3_REGION,
    SEND_BATCH_SIZE, MAX_BATCH_BYTES, MAX_TRACE_BYTES, SEND_DEADLINE_MARGIN_MS, FLUSH_THRESHOLD, TIME_SAFETY_MARGIN_MS, FETCH_TIMEOUT_MS, MAX_SEND_ATTEMPTS, LOOKBACK_DAYS,
    SCHEDULE_INTERVAL_MS, RUN_BUDGET_MS, S3_BUDGET_SHARE, S3_BUDGET_MS, INGEST_SERVICE_AGENT_TRAFFIC,
    RUNTIME_LOG_GROUP_PREFIX, MAX_LOG_EVENTS_PER_FETCH, TRACE_LOOKBACK_DAYS, TRACE_MARKERS_PREFIX, TRACE_MANIFEST_KEY,
    INTERCEPTOR_LAMBDA_ARN, INTERCEPTION_POINTS, INCLUDE_GATEWAY_IDS, EXCLUDE_GATEWAY_IDS, INTERCEPTOR_DRY_RUN,
    GATEWAY_MARKERS_PREFIX, GATEWAY_MANIFEST_KEY, GATEWAY_NAME_MAP_MAX_BYTES,
    validateConfig, initAwsClients,
    get bedrockAgentClient() { return bedrockAgentClient; },
    get bedrockAgentCoreControlClient() { return bedrockAgentCoreControlClient; },
    get cloudWatchLogsClient() { return cloudWatchLogsClient; },
    get iamClient() { return iamClient; },
    get s3Client() { return s3Client; },
    get markersS3Client() { return markersS3Client; },
    lambdaClient
};
