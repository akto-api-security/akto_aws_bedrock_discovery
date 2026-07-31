# AKTO Bedrock Discovery — Update Runbook

Steps to update your existing setup to the latest version. These update your current
resources in place — nothing is deleted or recreated.

This version merges in a second, independent pipeline: AgentCore Harness/Runtime
conversations, read from CloudWatch observability traces instead of S3. It runs in the
same Lambda, on the same schedule, with its own manifest file
(`akto/markers/agentcore-tracing/manifest.json`) so it never contends with the existing
S3 pipeline's checkpoint. It's a no-op (finds 0 log groups, logs nothing) if you haven't
enabled AgentCore CloudWatch Transaction Search + tracing on this account — that's a
separate, manual AWS console step this Lambda doesn't perform for you.

Run Step 0 once, then every step after it is copy-paste-as-is — no manual find/replace.

## Step 0 — Set your variables

Fill these in once, in the same terminal session you'll run every command below in.

```bash
export ACCOUNT_ID="<your AWS account ID>"          # aws sts get-caller-identity --query Account --output text
export REGION="<your region>"                       # e.g. us-east-1
export LOGS_BUCKET="<your bedrock logs bucket>"     # bucket Bedrock model invocation logging delivers to
export LOGS_PREFIX="<your logs prefix>"             # e.g. bedrock-logs/ or AWSLogs/ — check what's actually configured
export MARKERS_BUCKET="$LOGS_BUCKET"                # same bucket, different folder — simplest option, see below
export DATA_INGESTION_ENDPOINT="<AKTO ingest URL>"  # e.g. https://your-akto-instance.com:9095/api/ingestData
export AKTO_API_KEY="<AKTO API key>"
export RUNTIME_LOG_GROUP_PREFIX="/aws/bedrock-agentcore/runtimes/"  # AgentCore Harness/Runtime trace log groups — default matches AWS's own naming, only change if you customized it

# Derived — these follow the naming convention the old script/runbook uses. Don't edit.
export LAMBDA_FUNCTION_NAME="akto-bedrock-log-processor-${ACCOUNT_ID}"
export ROLE_NAME="akto-bedrock-processor-role-${ACCOUNT_ID}"
export RULE_NAME="akto-bedrock-schedule-${ACCOUNT_ID}"
```

`MARKERS_BUCKET` doesn't have to equal `LOGS_BUCKET` — two separate buckets work too, just
set it explicitly if so. One bucket with two folders is simpler if you don't already have
a second bucket.

## Step 1 — Confirm Bedrock model invocation logging is on

```bash
aws bedrock get-model-invocation-logging-configuration --region "$REGION"
```

Should show delivery to `$LOGS_BUCKET` / `$LOGS_PREFIX`. If not, enable it in the
console: Bedrock → Settings → Model invocation logging. Nothing in this update
configures Bedrock logging automatically — it has to already be on.

## Step 2 — Enable AgentCore CloudWatch tracing (optional)

Skip this step entirely if you don't have AgentCore Harnesses/Runtimes yet, or don't
need their conversation data — the AgentCore pipeline just no-ops (finds 0 log groups)
without it. This is a one-time, account-level setting, not per-resource: your
Harnesses/Runtimes already run inside AgentCore's managed runtime, so once this is on
they get OpenTelemetry instrumentation automatically — no per-agent config needed.

```bash
aws logs put-resource-policy --policy-name AgentCoreTransactionSearchAccess --policy-document "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{
    \"Sid\": \"TransactionSearchXRayAccess\",
    \"Effect\": \"Allow\",
    \"Principal\": {\"Service\": \"xray.amazonaws.com\"},
    \"Action\": \"logs:PutLogEvents\",
    \"Resource\": [
      \"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:aws/spans:*\",
      \"arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:/aws/application-signals/data:*\"
    ],
    \"Condition\": {
      \"ArnLike\": {\"aws:SourceArn\": \"arn:aws:xray:${REGION}:${ACCOUNT_ID}:*\"},
      \"StringEquals\": {\"aws:SourceAccount\": \"${ACCOUNT_ID}\"}
    }
  }]
}" \
  --region "$REGION"

aws xray update-trace-segment-destination --destination CloudWatchLogs --region "$REGION"
```

Or via the console: **CloudWatch → Settings** (under **Setup**) → **Account** tab →
**X-Ray traces** tab → **Transaction Search** section → **View settings** → **Edit** →
**Enable Transaction Search** → **Save**.

Takes about 10 minutes to take effect. Confirm it's live before testing:

```bash
aws xray get-trace-segment-destination --region "$REGION"
```

Should show `"Destination": "CloudWatchLogs"`, `"Status": "ACTIVE"`.

## Step 3 — Snapshot current Lambda (for rollback)

```bash
aws lambda publish-version \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --description "pre-update snapshot" \
  --region "$REGION"
```

Note the `Version` number returned — you'll need it if you ever need to roll back.

## Step 4 — Update the IAM policy

```bash
cat > policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::${LOGS_BUCKET}",
        "arn:aws:s3:::${LOGS_BUCKET}/${LOGS_PREFIX}*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::${MARKERS_BUCKET}",
        "arn:aws:s3:::${MARKERS_BUCKET}/akto/markers/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["bedrock:ListAgents", "bedrock:GetAgent", "bedrock:ListTagsForResource"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:ListHarnesses",
        "bedrock-agentcore:GetHarness",
        "bedrock-agentcore:ListAgentRuntimes",
        "bedrock-agentcore:GetAgentRuntime",
        "bedrock-agentcore:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["iam:ListAttachedRolePolicies"],
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/*"
    },
    {
      "Effect": "Allow",
      "Action": ["logs:DescribeLogGroups"],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["logs:FilterLogEvents"],
      "Resource": "arn:aws:logs:${REGION}:${ACCOUNT_ID}:log-group:${RUNTIME_LOG_GROUP_PREFIX}*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name AktoBedrockPolicy \
  --policy-document file://policy.json
```

`logs:DescribeLogGroups` gets its own statement with `Resource: "*"` — AWS doesn't support
scoping that specific action to a log-group ARN/prefix at all (unlike `FilterLogEvents`,
which does). Scoping it the same way fails with an `AccessDenied` error at runtime even
though the policy applies cleanly.



## Step 5 — Deploy the latest Lambda code

**Option A — download the pre-built zip (recommended, no local build tooling needed):**

```bash
curl -o akto-bedrock-processor.zip "<pre-signed URL provided by AKTO>"

aws lambda update-function-code \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --zip-file fileb://akto-bedrock-processor.zip \
  --region "$REGION"
```

AKTO team: generate that URL from the version already published for CloudFormation use
(see "Sharing the Lambda zip" below) — don't rebuild a one-off.

**Option B — build it yourself from source** (needs Node.js 22.x, npm, zip installed):

```bash
cd lambda-function
npm install
zip -r ../akto-bedrock-processor.zip . -x "*.git*" "node_modules/.cache/*"
cd ..

aws lambda update-function-code \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --zip-file fileb://akto-bedrock-processor.zip \
  --region "$REGION"
```



## Step 6 — Update environment variables and timeout

```bash
aws lambda update-function-configuration \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --timeout 900 \
  --environment "Variables={DATA_INGESTION_ENDPOINT=${DATA_INGESTION_ENDPOINT},AKTO_API_KEY=${AKTO_API_KEY},LOGS_BUCKET_NAME=${LOGS_BUCKET},LOGS_PREFIX=${LOGS_PREFIX},MARKERS_BUCKET_NAME=${MARKERS_BUCKET},RUNTIME_LOG_GROUP_PREFIX=${RUNTIME_LOG_GROUP_PREFIX},BEDROCK_AWS_REGION=${REGION},AWS_ACCOUNT_ID=${ACCOUNT_ID}}" \
  --region "$REGION"
```

This replaces the full variable set — that's why Step 0 collects everything up front,
not just what's changing.

## Step 7 — Update the schedule

```bash
aws events put-rule \
  --name "$RULE_NAME" \
  --schedule-expression "rate(10 minutes)" \
  --state ENABLED \
  --region "$REGION"
```



## Step 8 — Verify

```bash
aws lambda invoke \
  --function-name "$LAMBDA_FUNCTION_NAME" \
  --region "$REGION" response.json
cat response.json

aws s3 ls "s3://${MARKERS_BUCKET}/akto/markers/bedrock-logs/manifest.json"

# AgentCore Harness/Runtime trace pipeline's own manifest — only appears if you have
# CloudWatch Transaction Search + tracing enabled on this account
aws s3 ls "s3://${MARKERS_BUCKET}/akto/markers/agentcore-tracing/manifest.json"
```

Check the AKTO dashboard for new traffic tagged `source: AWS_BEDROCK`.

## Note

The first run after this update reprocesses the last 3 days of S3 logs (one-time, since
there's no manifest yet) and, separately, the last 3 days of AgentCore CloudWatch traces
(if tracing is enabled). Both are expected, one-time backfills.

## Rollback

If something breaks, restore the Lambda code from the version you published in Step 3,
then revert the environment variables/timeout/schedule to their previous values.

