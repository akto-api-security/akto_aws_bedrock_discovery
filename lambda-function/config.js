/**
 * Shared configuration, tunables, and AWS SDK client instances.
 * Every other module in this function reads its settings from here.
 */
const { BedrockAgentClient } = require('@aws-sdk/client-bedrock-agent');
const { BedrockAgentCoreControlClient } = require('@aws-sdk/client-bedrock-agentcore-control');
const { CloudWatchLogsClient } = require('@aws-sdk/client-cloudwatch-logs');
const { IAMClient } = require('@aws-sdk/client-iam');
const { S3Client } = require('@aws-sdk/client-s3');

const DATA_INGESTION_ENDPOINT = process.env.DATA_INGESTION_ENDPOINT;
const AKTO_API_KEY = process.env.AKTO_API_KEY;
const LOGS_BUCKET_NAME = process.env.LOGS_BUCKET_NAME;
const LOGS_PREFIX = process.env.LOGS_PREFIX || 'AWSLogs/';
const MARKERS_BUCKET_NAME = process.env.MARKERS_BUCKET_NAME;
const AWS_REGION = process.env.BEDROCK_AWS_REGION || process.env.AWS_REGION;
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;
const MARKERS_PREFIX = 'akto/markers/';
const MANIFEST_KEY = `${MARKERS_PREFIX}bedrock-logs/manifest.json`;

const SEND_BATCH_SIZE = 1;            // max messages per AKTO POST — 1 for now, send requests individually while verifying with the client
const FLUSH_THRESHOLD = 100;          // send+checkpoint once this many messages accumulate
const TIME_SAFETY_MARGIN_MS = 90000;  // stop starting new work with less than this much Lambda time left
const FETCH_TIMEOUT_MS = 25000;       // abort a stuck HTTP call instead of silently eating the whole invocation
const MAX_SEND_ATTEMPTS = 3;
const LOOKBACK_DAYS = 3;

// AgentCore Harness/Runtime conversation data (separate pipeline, see traceDiscovery.js/
// logGroupReader.js/traceParser.js) — CloudWatch observability logs instead of S3, so it
// gets its own lookback/manifest rather than sharing the S3 pipeline's above.
const RUNTIME_LOG_GROUP_PREFIX = process.env.RUNTIME_LOG_GROUP_PREFIX || '/aws/bedrock-agentcore/runtimes/';
const MAX_LOG_EVENTS_PER_FETCH = 1000; // CloudWatch FilterLogEvents page size cap
const TRACE_LOOKBACK_DAYS = 3;
const TRACE_MARKERS_PREFIX = `${MARKERS_PREFIX}agentcore-tracing/`;
const TRACE_MANIFEST_KEY = `${TRACE_MARKERS_PREFIX}manifest.json`;

/** Throws if any required environment variable is missing or blank. Call this first, before touching AWS. */
function validateConfig() {
    const required = { LOGS_BUCKET_NAME, LOGS_PREFIX, MARKERS_BUCKET_NAME, DATA_INGESTION_ENDPOINT, AKTO_API_KEY };
    for (const [key, value] of Object.entries(required)) {
        if (!value || !String(value).trim()) throw new Error(`${key} environment variable is required`);
    }
}

module.exports = {
    DATA_INGESTION_ENDPOINT, AKTO_API_KEY, LOGS_BUCKET_NAME, LOGS_PREFIX, MARKERS_BUCKET_NAME,
    AWS_REGION, AWS_ACCOUNT_ID, MARKERS_PREFIX, MANIFEST_KEY,
    SEND_BATCH_SIZE, FLUSH_THRESHOLD, TIME_SAFETY_MARGIN_MS, FETCH_TIMEOUT_MS, MAX_SEND_ATTEMPTS, LOOKBACK_DAYS,
    RUNTIME_LOG_GROUP_PREFIX, MAX_LOG_EVENTS_PER_FETCH, TRACE_LOOKBACK_DAYS, TRACE_MARKERS_PREFIX, TRACE_MANIFEST_KEY,
    validateConfig,
    bedrockAgentClient: new BedrockAgentClient({ region: AWS_REGION }),
    bedrockAgentCoreControlClient: new BedrockAgentCoreControlClient({ region: AWS_REGION }),
    cloudWatchLogsClient: new CloudWatchLogsClient({ region: AWS_REGION }),
    s3Client: new S3Client({ region: AWS_REGION }),
    iamClient: new IAMClient({ region: AWS_REGION })
};
