/**
 * Shared configuration, tunables, and AWS SDK client instances for the AKTO Amazon Quick
 * processor. Every other module reads its settings from here.
 *
 * Three AWS services are used, each for one narrow purpose:
 *   quicksight      - discover agents, MCP connectors and the asking user
 *   cloudwatch-logs - the vended-log DELIVERY APIs only (find or create the CHAT_LOGS
 *                     delivery). No log group is ever read; conversations come from S3.
 *   s3              - read chat logs, read/write the checkpoint, and create the logs
 *                     bucket when asked to enable logging
 *   iam             - resolve attached policies for an IAM-federated Quick user
 */
const { CloudWatchLogsClient } = require('@aws-sdk/client-cloudwatch-logs');
const { IAMClient } = require('@aws-sdk/client-iam');
const { QuickSightClient } = require('@aws-sdk/client-quicksight');
const { S3Client } = require('@aws-sdk/client-s3');

const DATA_INGESTION_ENDPOINT = process.env.DATA_INGESTION_ENDPOINT;
const AKTO_API_KEY = process.env.AKTO_API_KEY;
const MARKERS_BUCKET_NAME = process.env.MARKERS_BUCKET_NAME;
const AWS_REGION = process.env.QUICK_AWS_REGION || process.env.BEDROCK_AWS_REGION || process.env.AWS_REGION;
const AWS_ACCOUNT_ID = process.env.AWS_ACCOUNT_ID;

/**
 * Where this account+region's checkpoint lives inside the markers bucket.
 *
 * The markers bucket is central — one bucket in the Organization management account,
 * written to by every processor in every account and region:
 *
 *   s3://akto-markers-<mgmt>/<account-id>/<region>/quick-suite/manifest.json
 *
 * Both segments are required. Two Lambdas in the same account but different regions are
 * separate collectors with separate checkpoints, and without the region in the key they
 * would overwrite each other on every run.
 */
const MARKERS_PREFIX = `${AWS_ACCOUNT_ID}/${AWS_REGION}/`;
const QUICK_MARKERS_PREFIX = `${MARKERS_PREFIX}quick-suite/`;
const QUICK_MANIFEST_KEY = `${QUICK_MARKERS_PREFIX}manifest.json`;

/**
 * Messages per AKTO POST.
 *
 * 1 by default: the downstream broker rejects anything over 1MB, and one message per
 * request is the only setting under which a POST body cannot exceed a single message.
 */
const SEND_BATCH_SIZE = Number(process.env.SEND_BATCH_SIZE || 1);
const MAX_BATCH_BYTES = 5 * 1024 * 1024;   // an oversized POST fails the whole batch, not one message
const SEND_DEADLINE_MARGIN_MS = 15000;     // stop starting sends without time to finish and checkpoint
const FLUSH_THRESHOLD = 100;               // send+checkpoint once this many messages accumulate
const TIME_SAFETY_MARGIN_MS = 90000;       // stop taking new work below this much Lambda time
const FETCH_TIMEOUT_MS = 25000;            // abort a stuck HTTP call rather than eating the invocation
const MAX_SEND_ATTEMPTS = 3;

/**
 * How often EventBridge invokes this function. Not read from AWS — declared here so the
 * run budget can be derived from it. Keep it in step with the rule's ScheduleExpression.
 */
const SCHEDULE_INTERVAL_MS = Number(process.env.SCHEDULE_INTERVAL_MS || 600000);   // 10 minutes

/**
 * Wall-clock work budget for one run, deliberately shorter than the schedule interval so
 * a run always finishes before the next trigger fires. EventBridge fires on a timer
 * regardless of whether the previous invocation is still running, and two overlapping
 * runs would read the same checkpoint and send duplicates.
 */
const RUN_BUDGET_MS = Number(process.env.RUN_BUDGET_MS || Math.floor(SCHEDULE_INTERVAL_MS * 0.8));

/**
 * Ceiling on one message's traceData. Long tool/citation lists are truncated past this,
 * so a single conversation can never build a message the broker will refuse.
 */
const MAX_TRACE_BYTES = Number(process.env.MAX_TRACE_BYTES || 64 * 1024);

const QUICK_LOOKBACK_DAYS = Number(process.env.QUICK_LOOKBACK_DAYS || 3);

/**
 * How this account gets its Quick chat logs into S3.
 *
 *   'discover' - logging is already set up. Find the existing CHAT_LOGS delivery and read
 *                the bucket and path straight off it. Nothing is created.
 *   'create'   - logging is not set up. Create the bucket and the delivery, then read
 *                from what was just created.
 *
 * 'create' is safe on a mixed fleet: discovery always runs first, so an account that
 * already has a delivery is left alone rather than given a duplicate.
 */
const QUICK_LOGGING_MODE = String(process.env.QUICK_LOGGING_MODE || 'discover').trim().toLowerCase();

/**
 * Base name for the bucket created in 'create' mode. The account id AND region are both
 * appended: bucket names are global, so an account running Quick in two regions would
 * otherwise collide on the second CreateBucket.
 *   'akto-quick-logs' -> akto-quick-logs-041877753357-us-east-1
 */
const QUICK_BUCKET_BASE_NAME = (process.env.QUICK_BUCKET_BASE_NAME || '').trim();
const QUICK_CREATED_BUCKET_NAME = QUICK_BUCKET_BASE_NAME
    ? `${QUICK_BUCKET_BASE_NAME}-${AWS_ACCOUNT_ID}-${AWS_REGION}`
    : '';

/** Names for the delivery chain this function creates in 'create' mode. */
const QUICK_DELIVERY_SOURCE_NAME = process.env.QUICK_DELIVERY_SOURCE_NAME || 'akto-quick-chat-source';
const QUICK_DELIVERY_DESTINATION_NAME = process.env.QUICK_DELIVERY_DESTINATION_NAME || 'akto-quick-chat-s3-destination';

/**
 * Quick chat logs never name a model — the service doesn't expose which one answered. A
 * stable synthetic id keeps the `model` tag non-empty rather than 'unknown-model'.
 */
const QUICK_MODEL_ID = process.env.QUICK_MODEL_ID || 'amazon-quick-suite';

/** Namespace used for DescribeUser / ListIAMPolicyAssignmentsForUser when a user ARN doesn't carry one. */
const QUICK_NAMESPACE = process.env.QUICK_NAMESPACE || 'default';

/**
 * The agent_id Quick stamps on traffic handled by its built-in chat agent. Named "Quick"
 * with this same fixed id in every account, which is why bot-name gets the account id
 * appended — otherwise every account's built-in agent collapses into one dashboard entry.
 */
const QUICK_BUILTIN_AGENT_ID = 'SYSTEM';
const QUICK_BUILTIN_AGENT_NAME = process.env.QUICK_BUILTIN_AGENT_NAME || 'Quick';

/**
 * How often a discovery message is re-sent for a resource already in the manifest.
 *
 * Discovery used to be one-time, so anything the ingest API dropped never reappeared and
 * the only recovery was deleting the manifest — which also replays every conversation in
 * the lookback window. Re-announcing daily costs one message per resource per day and
 * lets the dashboard converge on its own.
 */
const QUICK_REDISCOVERY_HOURS = Number(process.env.QUICK_REDISCOVERY_HOURS || 24);

/**
 * Every field the CHAT_LOGS schema defines, including the five AWS does not deliver
 * unless asked (namespace, latency, time_to_first_token, surface_type, web_search).
 * CreateDelivery is the only place they can be requested and they cannot be added to an
 * existing delivery, so a delivery we create asks for all of them.
 */
const QUICK_RECORD_FIELDS = [
    'resource_arn', 'event_timestamp', 'logType', 'accountId', 'user_arn', 'user_type',
    'status_code', 'namespace', 'conversation_id', 'system_message_id', 'latency',
    'time_to_first_token', 'message_scope', 'user_message_id', 'user_message', 'agent_id',
    'flow_id', 'system_text_message', 'surface_type', 'web_search',
    'user_selected_resources', 'action_connectors', 'cited_resource', 'file_attachment'
];

/** Throws if the configuration cannot work. Call this first, before touching AWS. */
function validateConfig() {
    const required = { MARKERS_BUCKET_NAME, DATA_INGESTION_ENDPOINT, AKTO_API_KEY };
    for (const [key, value] of Object.entries(required)) {
        if (!value || !String(value).trim()) throw new Error(`${key} environment variable is required`);
    }
    // Every QuickSight API takes AwsAccountId explicitly — there is no "current account"
    // default — so an unset account id would fail every discovery call at runtime.
    if (!String(AWS_ACCOUNT_ID || '').trim()) {
        throw new Error('AWS_ACCOUNT_ID environment variable is required (QuickSight APIs take it explicitly)');
    }
    if (!['discover', 'create'].includes(QUICK_LOGGING_MODE)) {
        throw new Error(`QUICK_LOGGING_MODE must be 'discover' or 'create', got '${QUICK_LOGGING_MODE}'`);
    }
    if (QUICK_LOGGING_MODE === 'create' && !QUICK_BUCKET_BASE_NAME) {
        throw new Error("QUICK_BUCKET_BASE_NAME is required when QUICK_LOGGING_MODE is 'create' (it names the bucket this function will create)");
    }
}

module.exports = {
    DATA_INGESTION_ENDPOINT, AKTO_API_KEY, MARKERS_BUCKET_NAME, MARKERS_PREFIX,
    AWS_REGION, AWS_ACCOUNT_ID,
    SEND_BATCH_SIZE, MAX_BATCH_BYTES, SEND_DEADLINE_MARGIN_MS, FLUSH_THRESHOLD,
    TIME_SAFETY_MARGIN_MS, FETCH_TIMEOUT_MS, MAX_SEND_ATTEMPTS, MAX_TRACE_BYTES,
    SCHEDULE_INTERVAL_MS, RUN_BUDGET_MS,
    QUICK_LOOKBACK_DAYS, QUICK_MARKERS_PREFIX, QUICK_MANIFEST_KEY,
    QUICK_LOGGING_MODE, QUICK_BUCKET_BASE_NAME, QUICK_CREATED_BUCKET_NAME,
    QUICK_DELIVERY_SOURCE_NAME, QUICK_DELIVERY_DESTINATION_NAME, QUICK_RECORD_FIELDS,
    QUICK_MODEL_ID, QUICK_NAMESPACE, QUICK_BUILTIN_AGENT_ID, QUICK_BUILTIN_AGENT_NAME,
    QUICK_REDISCOVERY_HOURS,
    validateConfig,
    cloudWatchLogsClient: new CloudWatchLogsClient({ region: AWS_REGION }),
    iamClient: new IAMClient({ region: AWS_REGION }),
    quickSightClient: new QuickSightClient({ region: AWS_REGION }),
    s3Client: new S3Client({ region: AWS_REGION })
};
