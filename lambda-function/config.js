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

/**
 * Which build of this function is running.
 *
 * Read from a VERSION file baked into the deployment zip at package time, so it cannot
 * drift from the code it describes the way a separately-set environment variable can.
 * Reported in the startup banner, the run summary and the manifest, so the version each
 * account is running is visible without opening the console — which matters once the
 * updater starts rolling versions out on its own.
 */
const CODE_VERSION = (() => {
    try {
        return require('fs').readFileSync(require('path').join(__dirname, 'VERSION'), 'utf-8').trim() || 'unknown';
    } catch {
        // No VERSION file — a local checkout or a zip built before stamping existed.
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
const MARKERS_PREFIX = 'akto/markers/';
const MANIFEST_KEY = `${MARKERS_PREFIX}bedrock-logs/manifest.json`;

/**
 * Messages per AKTO POST.
 *
 * 1 by default: the downstream broker rejects anything over 1MB, and one message per
 * request is the only setting under which a POST body cannot exceed a single message.
 * Raise it (10 is comfortable once traces are scoped) to trade round trips for size.
 */
const SEND_BATCH_SIZE = Number(process.env.SEND_BATCH_SIZE || 1);
// A batch is also capped by size: ten long conversations can be large, and an
// oversized POST fails the whole batch rather than one message.
const MAX_BATCH_BYTES = 5 * 1024 * 1024;   // 5 MB
// Stop starting new sends with less than this much time left, so the final POST
// and the checkpoint that follows it can finish before the Lambda is killed.
const SEND_DEADLINE_MARGIN_MS = 15000;
const FLUSH_THRESHOLD = 100;          // send+checkpoint once this many messages accumulate
const TIME_SAFETY_MARGIN_MS = 90000;  // stop starting new work with less than this much Lambda time left

/**
 * How often EventBridge invokes this function. Not read from AWS — it's declared
 * here so the run budget below can be derived from it. Keep it in step with the
 * rule's ScheduleExpression.
 */
const SCHEDULE_INTERVAL_MS = Number(process.env.SCHEDULE_INTERVAL_MS || 600000);   // 10 minutes

/**
 * Wall-clock work budget for one run, deliberately shorter than the schedule
 * interval so a run always finishes before the next trigger fires.
 *
 * EventBridge fires on a timer regardless of whether the previous invocation is
 * still running, and Lambda runs overlapping invocations concurrently — two runs
 * would then read the same checkpoint, process the same files and send duplicates.
 *
 * The Lambda timeout stays as a crash net; this is the normal exit path.
 */
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || Math.floor(SCHEDULE_INTERVAL_MS * 0.8));  // 8 minutes

/**
 * How much of the run budget the S3 pipeline may hold before it has to hand over.
 *
 * This is a floor for AgentCore, not a cap on S3: whichever pipeline finishes early
 * releases its unused time to the other, so a quiet AgentCore account still gives S3
 * the whole budget. What it prevents is the failure mode where a large S3 backlog
 * consumes every run and CloudWatch traces are never read at all.
 */
const S3_BUDGET_SHARE = Number(process.env.S3_BUDGET_SHARE || 0.5);
const S3_BUDGET_MS = Math.floor(RUN_BUDGET_MS * S3_BUDGET_SHARE);   // 4 minutes of the 8

/**
 * Whether model invocations that belong to no agent — an application or a person
 * calling Bedrock directly — are ingested and attributed to the calling principal
 * (bot-name = the role or user name) rather than skipped.
 *
 * On by default: in real accounts this is the bulk of Gen-AI traffic and it is worth
 * seeing. Set to 'false' to fall back to agent-only ingestion without a redeploy.
 */
const INGEST_SERVICE_AGENT_TRAFFIC = String(process.env.INGEST_SERVICE_AGENT_TRAFFIC || 'true').toLowerCase() !== 'false';

/**
 * Ceiling on one message's traceData. Tool results are truncated (longest first) past
 * this, so a single long-running agent conversation can never build a message the
 * broker will refuse. Well under the 1MB limit, leaving room for the rest of the message.
 */
const MAX_TRACE_BYTES = Number(process.env.MAX_TRACE_BYTES || 64 * 1024);

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

// AgentCore Gateway interception (gatewayAttacher.js / gatewayDiscovery.js /
// gatewayInterceptor.js). Only the attacher Lambda reads these — the interceptor
// itself has its own config module with no SDK imports (interceptorConfig.js).
const INTERCEPTOR_LAMBDA_ARN = process.env.INTERCEPTOR_LAMBDA_ARN || '';
const INTERCEPTION_POINTS = ['REQUEST', 'RESPONSE'];
// Empty include list = every gateway in the region. Both accept comma-separated
// gateway IDs and exist for staged rollout / carve-outs, not day-to-day use.
const INCLUDE_GATEWAY_IDS = parseIdList(process.env.INCLUDE_GATEWAY_IDS);
const EXCLUDE_GATEWAY_IDS = parseIdList(process.env.EXCLUDE_GATEWAY_IDS);
// Logs every attach decision without calling UpdateGateway — use before the
// first real run against a client account.
const INTERCEPTOR_DRY_RUN = String(process.env.INTERCEPTOR_DRY_RUN || '').trim().toLowerCase() === 'true';
// Gateways get their own marker folder, like the S3 and trace pipelines, so their
// discovery bookkeeping never contends with either checkpoint.
const GATEWAY_MARKERS_PREFIX = `${MARKERS_PREFIX}agentcore-gateways/`;
const GATEWAY_MANIFEST_KEY = `${GATEWAY_MARKERS_PREFIX}manifest.json`;
// Lambda caps all environment variables at 4KB combined. The published map only
// carries gateways whose name can't be derived from their ID (normally none), so
// this is an exception budget rather than a per-gateway cost — but it is measured
// in real bytes so a few long names can't silently break the write.
const GATEWAY_NAME_MAP_MAX_BYTES = 3000;

/** Splits a comma-separated env var into a trimmed, non-empty list. */
function parseIdList(value) {
    return String(value || '').split(',').map((id) => id.trim()).filter(Boolean);
}

/** Throws if any required environment variable is missing or blank. Call this first, before touching AWS. */
function validateConfig() {
    const required = { LOGS_BUCKET_NAME, LOGS_PREFIX, MARKERS_BUCKET_NAME, DATA_INGESTION_ENDPOINT, AKTO_API_KEY };
    for (const [key, value] of Object.entries(required)) {
        if (!value || !String(value).trim()) throw new Error(`${key} environment variable is required`);
    }
}

module.exports = {
    CODE_VERSION,
    DATA_INGESTION_ENDPOINT, AKTO_API_KEY, LOGS_BUCKET_NAME, LOGS_PREFIX, MARKERS_BUCKET_NAME,
    AWS_REGION, AWS_ACCOUNT_ID, MARKERS_PREFIX, MANIFEST_KEY,
    SEND_BATCH_SIZE, MAX_BATCH_BYTES, MAX_TRACE_BYTES, SEND_DEADLINE_MARGIN_MS, FLUSH_THRESHOLD, TIME_SAFETY_MARGIN_MS, FETCH_TIMEOUT_MS, MAX_SEND_ATTEMPTS, LOOKBACK_DAYS,
    SCHEDULE_INTERVAL_MS, RUN_BUDGET_MS, S3_BUDGET_SHARE, S3_BUDGET_MS, INGEST_SERVICE_AGENT_TRAFFIC,
    RUNTIME_LOG_GROUP_PREFIX, MAX_LOG_EVENTS_PER_FETCH, TRACE_LOOKBACK_DAYS, TRACE_MARKERS_PREFIX, TRACE_MANIFEST_KEY,
    INTERCEPTOR_LAMBDA_ARN, INTERCEPTION_POINTS, INCLUDE_GATEWAY_IDS, EXCLUDE_GATEWAY_IDS, INTERCEPTOR_DRY_RUN,
    GATEWAY_MARKERS_PREFIX, GATEWAY_MANIFEST_KEY, GATEWAY_NAME_MAP_MAX_BYTES,
    validateConfig,
    bedrockAgentClient: new BedrockAgentClient({ region: AWS_REGION }),
    bedrockAgentCoreControlClient: new BedrockAgentCoreControlClient({ region: AWS_REGION }),
    cloudWatchLogsClient: new CloudWatchLogsClient({ region: AWS_REGION }),
    s3Client: new S3Client({ region: AWS_REGION }),
    iamClient: new IAMClient({ region: AWS_REGION }),
    lambdaClient: new LambdaClient({ region: AWS_REGION })
};
