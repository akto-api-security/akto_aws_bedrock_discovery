/**
 * Shared configuration, tunables, and AWS SDK client instances.
 * Every other module in this function reads its settings from here.
 */
const { BedrockAgentClient } = require('@aws-sdk/client-bedrock-agent');
const { BedrockAgentCoreControlClient } = require('@aws-sdk/client-bedrock-agentcore-control');
const { CloudWatchLogsClient } = require('@aws-sdk/client-cloudwatch-logs');
const { IAMClient } = require('@aws-sdk/client-iam');
const { QuickSightClient } = require('@aws-sdk/client-quicksight');
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
 * Per-pipeline on/off switches.
 *
 * Both default to on, so an existing deployment behaves exactly as before. Turning one
 * off skips its pipeline entirely AND lets the CloudFormation template drop the IAM
 * permissions it alone needs — an account that only uses Quick Suite has no reason to
 * grant bedrock:*, bedrock-agentcore:* or logs:DescribeLogGroups.
 *
 * Quick has no flag of its own: QUICK_LOGS_PREFIX below already serves as one, since
 * the pipeline cannot run without knowing where to read.
 */
const BEDROCK_CLASSIC_ENABLED = String(process.env.BEDROCK_CLASSIC_ENABLED || 'true').toLowerCase() !== 'false';
const AGENTCORE_ENABLED = String(process.env.AGENTCORE_ENABLED || 'true').toLowerCase() !== 'false';

/**
 * Amazon Quick Suite chat logs (third pipeline, see quickLogs.js/quickParser.js/
 * quickDiscovery.js). Delivered to S3 by CloudWatch Logs vended-log delivery
 * (PutDeliverySource logType=CHAT_LOGS), so the shape is nothing like Bedrock's
 * model-invocation logs and gets its own parser and manifest.
 *
 * The prefix is the on/off switch: blank (the default) means the account hasn't set
 * Quick log delivery up, and the whole pipeline is skipped without touching S3 or
 * QuickSight. Existing deployments therefore keep behaving exactly as before until
 * the prefix is set.
 */
const QUICK_LOGS_PREFIX = (process.env.QUICK_LOGS_PREFIX || '').trim();
// Quick's vended logs often land in a different bucket from Bedrock's. Blank means
// "same bucket as the Bedrock logs", which is the common single-bucket setup.
const QUICK_LOGS_BUCKET_NAME = (process.env.QUICK_LOGS_BUCKET_NAME || '').trim() || LOGS_BUCKET_NAME;
const QUICK_ENABLED = QUICK_LOGS_PREFIX.length > 0;
const QUICK_LOOKBACK_DAYS = Number(process.env.QUICK_LOOKBACK_DAYS || 3);
const QUICK_MARKERS_PREFIX = `${MARKERS_PREFIX}quick-suite/`;
const QUICK_MANIFEST_KEY = `${QUICK_MARKERS_PREFIX}manifest.json`;
/**
 * Quick chat logs never name a model — the service doesn't expose which one answered.
 * A stable synthetic id keeps the AKTO message path and `model` tag non-empty rather
 * than emitting 'unknown-model' for every single Quick message.
 */
const QUICK_MODEL_ID = process.env.QUICK_MODEL_ID || 'amazon-quick-suite';
/** Namespace used for DescribeUser / ListIAMPolicyAssignmentsForUser when a user ARN doesn't carry one. */
const QUICK_NAMESPACE = process.env.QUICK_NAMESPACE || 'default';
/**
 * The agent_id Quick stamps on traffic handled by its built-in chat agent rather than
 * a customer-created one. ListAgents never returns it, so it's discovered from the
 * logs themselves (see quickDiscovery.buildBuiltinAgentDiscoveryMessage).
 */
const QUICK_BUILTIN_AGENT_ID = 'SYSTEM';
const QUICK_BUILTIN_AGENT_NAME = process.env.QUICK_BUILTIN_AGENT_NAME || 'Quick Suite Built-in Chat';

/**
 * How much of the run budget each pipeline may hold before it has to hand over.
 *
 * These are floors for the pipelines that run later, not caps on the ones that run
 * first: whichever pipeline finishes early releases its unused time to the next, so a
 * quiet AgentCore/Quick account still gives S3 the whole budget. What they prevent is
 * the failure mode where a large S3 backlog consumes every run and CloudWatch traces
 * (or Quick logs) are never read at all.
 *
 * The budget is split evenly across whichever pipelines are actually enabled, so a
 * disabled one never reserves time it can't use. With the default two enabled that is
 * the same 50/50 split as before; enable all three and it becomes thirds; run only one
 * and it gets the whole budget.
 */
const ENABLED_PIPELINE_COUNT = [BEDROCK_CLASSIC_ENABLED, AGENTCORE_ENABLED, QUICK_ENABLED].filter(Boolean).length || 1;
const DEFAULT_PIPELINE_SHARE = 1 / ENABLED_PIPELINE_COUNT;
const S3_BUDGET_SHARE = Number(process.env.S3_BUDGET_SHARE || (BEDROCK_CLASSIC_ENABLED ? DEFAULT_PIPELINE_SHARE : 0));
const AGENTCORE_BUDGET_SHARE = Number(process.env.AGENTCORE_BUDGET_SHARE || (AGENTCORE_ENABLED ? DEFAULT_PIPELINE_SHARE : 0));
// Both are deadlines measured from the start of the run, not durations, because
// index.js's sliceTimeLeft() compares them against elapsed time. AgentCore's is
// therefore cumulative: S3's share plus its own. Quick gets whatever is left.
const S3_BUDGET_MS = Math.floor(RUN_BUDGET_MS * S3_BUDGET_SHARE);
const AGENTCORE_BUDGET_MS = Math.floor(RUN_BUDGET_MS * (S3_BUDGET_SHARE + AGENTCORE_BUDGET_SHARE));

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

/** Throws if any required environment variable is missing or blank. Call this first, before touching AWS. */
function validateConfig() {
    // Needed by every pipeline: all three checkpoint into the markers bucket and all
    // three deliver to the same AKTO endpoint.
    const required = { MARKERS_BUCKET_NAME, DATA_INGESTION_ENDPOINT, AKTO_API_KEY };
    // Only the Bedrock Agent Classic pipeline reads the Bedrock logs bucket, so a
    // Quick-only or AgentCore-only deployment can legitimately leave it unset.
    if (BEDROCK_CLASSIC_ENABLED) Object.assign(required, { LOGS_BUCKET_NAME, LOGS_PREFIX });
    for (const [key, value] of Object.entries(required)) {
        if (!value || !String(value).trim()) throw new Error(`${key} environment variable is required`);
    }

    if (!BEDROCK_CLASSIC_ENABLED && !AGENTCORE_ENABLED && !QUICK_ENABLED) {
        throw new Error('No pipeline is enabled — set at least one of BEDROCK_CLASSIC_ENABLED, AGENTCORE_ENABLED, or QUICK_LOGS_PREFIX');
    }

    if (QUICK_ENABLED) {
        // Every QuickSight API this function calls takes AwsAccountId explicitly — there's
        // no "current account" default — so an unset account id would fail every Quick
        // discovery call at runtime rather than here.
        if (!String(AWS_ACCOUNT_ID || '').trim()) {
            throw new Error('AWS_ACCOUNT_ID environment variable is required when QUICK_LOGS_PREFIX is set (QuickSight APIs take it explicitly)');
        }
        // QUICK_LOGS_BUCKET_NAME falls back to LOGS_BUCKET_NAME, which a Quick-only
        // deployment may have left blank — catch that here rather than as an empty
        // bucket name in the first ListObjectsV2 call.
        if (!String(QUICK_LOGS_BUCKET_NAME || '').trim()) {
            throw new Error('QUICK_LOGS_BUCKET_NAME is required when QUICK_LOGS_PREFIX is set and LOGS_BUCKET_NAME is unset (there is no bucket to read Quick logs from)');
        }
    }
}

module.exports = {
    DATA_INGESTION_ENDPOINT, AKTO_API_KEY, LOGS_BUCKET_NAME, LOGS_PREFIX, MARKERS_BUCKET_NAME,
    AWS_REGION, AWS_ACCOUNT_ID, MARKERS_PREFIX, MANIFEST_KEY,
    SEND_BATCH_SIZE, MAX_BATCH_BYTES, MAX_TRACE_BYTES, SEND_DEADLINE_MARGIN_MS, FLUSH_THRESHOLD, TIME_SAFETY_MARGIN_MS, FETCH_TIMEOUT_MS, MAX_SEND_ATTEMPTS, LOOKBACK_DAYS,
    SCHEDULE_INTERVAL_MS, RUN_BUDGET_MS, S3_BUDGET_SHARE, S3_BUDGET_MS, AGENTCORE_BUDGET_SHARE, AGENTCORE_BUDGET_MS, INGEST_SERVICE_AGENT_TRAFFIC,
    BEDROCK_CLASSIC_ENABLED, AGENTCORE_ENABLED,
    RUNTIME_LOG_GROUP_PREFIX, MAX_LOG_EVENTS_PER_FETCH, TRACE_LOOKBACK_DAYS, TRACE_MARKERS_PREFIX, TRACE_MANIFEST_KEY,
    QUICK_ENABLED, QUICK_LOGS_BUCKET_NAME, QUICK_LOGS_PREFIX, QUICK_LOOKBACK_DAYS, QUICK_MARKERS_PREFIX, QUICK_MANIFEST_KEY,
    QUICK_MODEL_ID, QUICK_NAMESPACE, QUICK_BUILTIN_AGENT_ID, QUICK_BUILTIN_AGENT_NAME,
    validateConfig,
    bedrockAgentClient: new BedrockAgentClient({ region: AWS_REGION }),
    bedrockAgentCoreControlClient: new BedrockAgentCoreControlClient({ region: AWS_REGION }),
    cloudWatchLogsClient: new CloudWatchLogsClient({ region: AWS_REGION }),
    s3Client: new S3Client({ region: AWS_REGION }),
    iamClient: new IAMClient({ region: AWS_REGION }),
    quickSightClient: new QuickSightClient({ region: AWS_REGION })
};
