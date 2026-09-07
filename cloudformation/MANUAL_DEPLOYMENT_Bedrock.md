# AWS Bedrock → Akto: Manual Deployment Guide

This guide is Manual deployment guide of AWS Bedrock-Akto Integration

Every step is given twice — once for the **AWS Console (UI)** and once for the **AWS CLI**. Use whichever you prefer; the result is identical.

**Time required:** about 30–40 minutes.

---

## What you are building

One Lambda function runs every 10 minutes and feeds Akto from **two independent sources**:

| Pipeline | Reads from | Covers |
|---|---|---|
| **Bedrock Agent Classic** | S3 model invocation logs | `InvokeModel` / `InvokeAgent` traffic — Bedrock agents and direct model callers |

The two are completely separate. An AgentCore runtime never appears in the S3 logs, and a classic Bedrock agent never appears in the CloudWatch traces. **Set up whichever applies to you — or both.**

```
Bedrock model invocations
        │
        ▼  (Steps 2–3: model invocation logging)
   S3 logs bucket ─────────────┐
                               ▼
           Lambda ──► Akto ingest API
                               │
                               ▼
                       S3 markers bucket (checkpoint)
                               ▲
                      EventBridge, every 10 min
```

A second S3 bucket holds small checkpoint files — one per pipeline — so each run resumes where the last one stopped.

### Resources created

| # | Resource | Name | Needed for |
|---|---|---|---|
| 1 | S3 bucket — Bedrock logs | your choice | Agent Classic |
| 2 | S3 bucket — Akto markers | your choice | both |
| 3 | Bedrock model invocation logging | account + region setting | Agent Classic |
| 5 | IAM policy | `AktoBedrockPolicy` | both |
| 6 | IAM role | `akto-bedrock-processor-cf-<ACCOUNT_ID>` | both |
| 7 | Lambda function | `akto-bedrock-log-processor-cf-<ACCOUNT_ID>` | both |
| 8 | EventBridge rule | `akto-bedrock-schedule-cf-<ACCOUNT_ID>` | both |
| 9 | Lambda invoke permission | resource policy on the function | both |

The two S3 buckets may be buckets you already own. Everything else is new.


## Before you start

### Permissions you need

The person performing this deployment needs permission to create IAM roles and policies, create Lambda functions, create EventBridge rules, create S3 buckets and set bucket policies, and change Bedrock logging configuration.

### Values to collect

Fill this table in first and keep it beside you — every command below refers to these.

| Placeholder | Meaning | Example                             |
|---|---|-------------------------------------|
| `ACCOUNT_ID` | Your 12-digit AWS account id | `041877xxxxxx`                      |
| `REGION` | Region where Bedrock runs | `us-east-1`                         |
| `LOGS_BUCKET` | Bucket for Bedrock logs | `abc-bedrock-logs`                  |
| `MARKERS_BUCKET` | Bucket for Akto checkpoints | `acme-akto-markers`                 |
| `AKTO_ENDPOINT` | Your Akto ingest URL | `https://123456-guardrails.akto.io` |
| `AKTO_API_KEY` | Provided by Akto | `*************`                     |
| `CODE_VERSION` | Lambda code version from Akto | `v3.6`                              |

> **Region matters.** Bedrock logging is configured **per account per region**. If you use Bedrock in more than one region, repeat this entire guide once per region.

To find your account id:

```bash
aws sts get-caller-identity --query Account --output text
```

---

## Step 1 — Create the S3 bucket for Bedrock logs

Skip this if you already have a bucket where Bedrock logs should land.

### UI

1. Open **S3** → **Create bucket**
2. **Bucket name:** `LOGS_BUCKET`
3. **Region:** must match `REGION`
4. Leave **Block all public access** enabled
5. **Create bucket**

### CLI

`us-east-1` is the exception that rejects a location constraint — use the second form for every other region.

```bash
# us-east-1
aws s3api create-bucket --bucket LOGS_BUCKET --region us-east-1

# any other region
aws s3api create-bucket --bucket LOGS_BUCKET --region REGION \
  --create-bucket-configuration LocationConstraint=REGION
```

---

## Step 2 — Let Bedrock write to that bucket

Bedrock cannot write to your bucket until its service principal is authorised. **Do this before Step 3** — enabling logging validates the permission and fails without it.

Save as `bedrock-bucket-policy.json`, substituting your values:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowBedrockModelInvocationLogs",
      "Effect": "Allow",
      "Principal": { "Service": "bedrock.amazonaws.com" },
      "Action": "s3:PutObject",
      "Resource": "arn:aws:s3:::LOGS_BUCKET/AWSLogs/ACCOUNT_ID/*",
      "Condition": {
        "StringEquals": { "aws:SourceAccount": "ACCOUNT_ID" },
        "ArnLike": { "aws:SourceArn": "arn:aws:bedrock:REGION:ACCOUNT_ID:*" }
      }
    }
  ]
}
```

> **Do not add** an `s3:x-amz-acl` condition, even though some older AWS documentation shows one. Buckets created since April 2023 default to *Bucket owner enforced* ownership, which **rejects** any upload carrying an ACL. With that condition present the statement can never match, writes are denied, and no logs ever appear — a failure that looks exactly like "we have no Bedrock traffic".

### UI

1. **S3** → your bucket → **Permissions** tab
2. **Bucket policy** → **Edit**
3. Paste the JSON above → **Save changes**

### CLI

```bash
aws s3api put-bucket-policy \
  --bucket LOGS_BUCKET \
  --policy file://bedrock-bucket-policy.json
```

---

## Step 3 — Enable Bedrock model invocation logging

This is what actually produces the data Akto reads. Without it the Lambda deploys correctly and finds nothing.

### UI

1. Open **Amazon Bedrock** → bottom-left **Settings**
2. Find **Model invocation logging** → toggle **on**
3. Tick **S3 only** as the destination
4. **S3 location:** `s3://LOGS_BUCKET`
5. Under **Log data**, tick **Text**
6. **Save settings**

### CLI

```bash
aws bedrock put-model-invocation-logging-configuration \
  --region REGION \
  --logging-config '{
    "s3Config": { "bucketName": "LOGS_BUCKET", "keyPrefix": "" },
    "textDataDeliveryEnabled": true,
    "imageDataDeliveryEnabled": false,
    "embeddingDataDeliveryEnabled": false
  }'
```

Confirm it took effect:

```bash
aws bedrock get-model-invocation-logging-configuration --region REGION
```

### Why text only

Image and embedding delivery write binary payloads and vectors into every log record. They add nothing to conversation capture and make each message far larger — and message size is the first limit this pipeline meets, at both the Akto ingest API and its message broker. Leave them off unless Akto advises otherwise.

### Important — this replaces any existing configuration

Bedrock keeps **one** logging configuration per account per region. If you are already logging to CloudWatch, the command above **removes** that. To keep both, include your existing CloudWatch block alongside the S3 one:

```bash
# 1. Read what you have now
aws bedrock get-model-invocation-logging-configuration --region REGION

# 2. Re-submit it WITH s3Config added
aws bedrock put-model-invocation-logging-configuration --region REGION \
  --logging-config '{
    "cloudWatchConfig": {
      "logGroupName": "YOUR-EXISTING-LOG-GROUP",
      "roleArn": "YOUR-EXISTING-ROLE-ARN"
    },
    "s3Config": { "bucketName": "LOGS_BUCKET", "keyPrefix": "" },
    "textDataDeliveryEnabled": true
  }'
```

### Where the logs land

```
s3://LOGS_BUCKET/AWSLogs/ACCOUNT_ID/BedrockModelInvocationLogs/REGION/YYYY/MM/DD/HH/*.json.gz
```

Requests or responses larger than 100 KB are written by Bedrock as separate objects under a `data/` folder, and the main log entry points at them. The Lambda follows those pointers automatically — no extra configuration.

Logs can take a few minutes to appear after the first Bedrock call.



## Step 4 — Create the markers bucket

This holds one small JSON checkpoint recording how far the last run got. It can be the same bucket as `LOGS_BUCKET` if you prefer, but a separate one is cleaner.

### UI

**S3** → **Create bucket** → name it `MARKERS_BUCKET` or you can use the same bucket where logs are stored, same region, defaults otherwise.

### CLI

```bash
# us-east-1
aws s3api create-bucket --bucket MARKERS_BUCKET --region us-east-1

# any other region
aws s3api create-bucket --bucket MARKERS_BUCKET --region REGION \
  --create-bucket-configuration LocationConstraint=REGION
```

> Do not delete this bucket or the file inside it. Losing the checkpoint makes the next run replay its full 3-day lookback window and re-send conversations Akto already holds.

---

## Step 5 — Create the IAM policy

Save as `akto-bedrock-policy.json`. Replace `ACCOUNT_ID`, `REGION`, `LOGS_BUCKET` and `MARKERS_BUCKET` throughout.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ReadBedrockLogs",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::LOGS_BUCKET",
        "arn:aws:s3:::LOGS_BUCKET/<prefix if present>AWSLogs/*"
      ]
    },
    {
      "Sid": "ReadWriteCheckpoint",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::MARKERS_BUCKET",
        "arn:aws:s3:::MARKERS_BUCKET/akto/markers/*"
      ]
    },
    {
      "Sid": "DiscoverBedrockAgents",
      "Effect": "Allow",
      "Action": [
        "bedrock:ListAgents",
        "bedrock:GetAgent",
        "bedrock:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DiscoverAgentCoreResources",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:ListHarnesses",
        "bedrock-agentcore:GetHarness",
        "bedrock-agentcore:ListTagsForResource",
        "bedrock-agentcore:ListAgentRuntimes",
        "bedrock-agentcore:GetAgentRuntime"
      ],
      "Resource": "*"
    },
    {
      "Sid": "InspectExecutionRoles",
      "Effect": "Allow",
      "Action": "iam:ListAttachedRolePolicies",
      "Resource": "arn:aws:iam::ACCOUNT_ID:role/*"
    },
    {
      "Sid": "ListObservabilityLogGroups",
      "Effect": "Allow",
      "Action": "logs:DescribeLogGroups",
      "Resource": "*"
    },
    {
      "Sid": "ReadObservabilityLogs",
      "Effect": "Allow",
      "Action": "logs:FilterLogEvents",
      "Resource": "arn:aws:logs:REGION:ACCOUNT_ID:log-group:/aws/bedrock-agentcore/runtimes/*"
    }
  ]
}
```

### What each block is for

| Statement | Purpose |
|---|---|
| `ReadBedrockLogs` | Read the `.gz` conversation logs |
| `ReadWriteCheckpoint` | Read and write the resume marker |
| `DiscoverBedrockAgents` | Name agents and read their tags |
| `DiscoverAgentCoreResources` | Discover AgentCore harnesses and runtimes |
| `InspectExecutionRoles` | Report an agent's effective permissions |
| `ReadObservabilityLogs` | Read AgentCore traces, scoped to that log-group prefix |

Nothing here grants write access to Bedrock, and nothing grants read access to any bucket other than the two you named.

> If you use a custom `LOGS_PREFIX` rather than the default `AWSLogs/`, change `arn:aws:s3:::LOGS_BUCKET/AWSLogs/*` to match, and set the `LOGS_PREFIX` environment variable in Step 8.

### UI

1. **IAM** → **Policies** → **Create policy**
2. Select the **JSON** tab, replace the contents with the policy above
3. **Next** → **Policy name:** `AktoBedrockPolicy`
4. **Create policy**

### CLI

```bash
aws iam create-policy \
  --policy-name AktoBedrockPolicy \
  --policy-document file://akto-bedrock-policy.json
```

Note the returned ARN — you need it in Step 7.

---

## Step 6 — Create the IAM role

### UI

1. **IAM** → **Roles** → **Create role**
2. **Trusted entity type:** AWS service
3. **Use case:** Lambda → **Next**
4. Search for and tick **`AktoBedrockPolicy`**
5. Also tick **`AWSLambdaBasicExecutionRole`** *(this is what lets the function write its own CloudWatch logs — without it you cannot troubleshoot anything)*
6. **Next** → **Role name:** `akto-bedrock-processor-cf-ACCOUNT_ID`
7. **Create role**

### CLI

Save the trust policy as `lambda-trust-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "lambda.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

```bash
# Create the role
aws iam create-role \
  --role-name akto-bedrock-processor-cf-ACCOUNT_ID \
  --assume-role-policy-document file://lambda-trust-policy.json

# Attach your policy
aws iam attach-role-policy \
  --role-name akto-bedrock-processor-cf-ACCOUNT_ID \
  --policy-arn arn:aws:iam::ACCOUNT_ID:policy/AktoBedrockPolicy

# Attach the AWS-managed basic execution policy
aws iam attach-role-policy \
  --role-name akto-bedrock-processor-cf-ACCOUNT_ID \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
```

---

## Step 7 — Create the Lambda function

### Get the code

Akto publishes the deployment package at:

```
https://lambda-code-akto-REGION.s3.REGION.amazonaws.com/CODE_VERSION/akto-bedrock-processor.zip
```

Download it if you plan to upload through the console:

```bash
curl -O https://lambda-code-akto-us-east-1.s3.us-east-1.amazonaws.com/v3.6/akto-bedrock-processor.zip
```

Confirm your Akto contact which `CODE_VERSION` to use before deploying.

### Function settings

| Setting | Value |
|---|---|
| Function name | `akto-bedrock-log-processor-cf-ACCOUNT_ID` |
| Runtime | **Node.js 22.x** |
| Architecture | x86_64 |
| Handler | `index.handler` |
| Timeout | **900 seconds (15 min)** |
| Memory | **1024 MB** |
| Execution role | the role from Step 7 |

> Both the timeout and the memory matter. The default 3-second timeout kills the function before it finishes, and the default 128 MB is not enough to decompress and parse a batch of log files.

### UI

1. **Lambda** → **Create function** → **Author from scratch**
2. **Function name:** `akto-bedrock-log-processor-cf-ACCOUNT_ID`
3. **Runtime:** Node.js 22.x
4. Scroll down to **Change default execution role** and click the arrow to expand it — it is collapsed by default and easy to miss. Choose **Use an existing role**, then pick **`akto-bedrock-processor-cf-ACCOUNT_ID`** from the dropdown — the role you created in Step 7.
5. **Create function**

> **Do not skip step 4.** Left collapsed, Lambda quietly creates a brand-new role with only basic logging permissions. The function is created and looks fine, but every run fails with `AccessDenied` because that role cannot read your buckets or call Bedrock. This is the single most common mistake in this guide.
>
> If you already made this mistake, you do not need to delete the function — go to **Configuration** → **Permissions** → **Edit** and change the execution role there.
6. On the **Code** tab → **Upload from** → **.zip file** (or **Amazon S3 location** and paste the URL above) → **Save**
7. **Configuration** → **General configuration** → **Edit**: Memory `1024`, Timeout `15 min` → **Save**
8. **Configuration** → **Environment variables** → **Edit**, add each row from the table below → **Save**

### CLI

```bash
aws lambda create-function \
  --function-name akto-bedrock-log-processor-cf-ACCOUNT_ID \
  --runtime nodejs22.x \
  --handler index.handler \
  --role arn:aws:iam::ACCOUNT_ID:role/akto-bedrock-processor-cf-ACCOUNT_ID \
  --code S3Bucket=lambda-code-akto-REGION,S3Key=CODE_VERSION/akto-bedrock-processor.zip \
  --timeout 900 \
  --memory-size 1024 \
  --region REGION \
  --environment 'Variables={
      DATA_INGESTION_ENDPOINT=AKTO_ENDPOINT,
      AKTO_API_KEY=AKTO_API_KEY,
      LOGS_BUCKET_NAME=LOGS_BUCKET,
      LOGS_PREFIX=AWSLogs/,
      MARKERS_BUCKET_NAME=MARKERS_BUCKET,
      RUNTIME_LOG_GROUP_PREFIX=/aws/bedrock-agentcore/runtimes/,
      BEDROCK_AWS_REGION=REGION,
      AWS_ACCOUNT_ID=ACCOUNT_ID
  }'
```

> If the role was created moments earlier, this can fail with *"The role defined for the function cannot be assumed by Lambda"*. That is IAM propagation, not a mistake — wait 10 seconds and run it again.

### Environment variables

| Variable | Value | Required |
|---|---|---|
| `DATA_INGESTION_ENDPOINT` | `AKTO_ENDPOINT` | Yes |
| `AKTO_API_KEY` | `AKTO_API_KEY` | Yes |
| `LOGS_BUCKET_NAME` | `LOGS_BUCKET` | Yes |
| `LOGS_PREFIX` | `AWSLogs/` | Yes |
| `MARKERS_BUCKET_NAME` | `MARKERS_BUCKET` | Yes |
| `BEDROCK_AWS_REGION` | `REGION` | Yes |
| `AWS_ACCOUNT_ID` | `ACCOUNT_ID` | Yes |



---

## Step 8 — Schedule it with EventBridge

### UI

1. Open **Amazon EventBridge**
2. In the left navigation, under **Scheduler**, click **Scheduled rules (legacy)**
3. Click **Create scheduled rule** (orange button, top right)

That opens a five-step wizard:

| Wizard step | What to enter                                                                                                                                                                                                               |
|---|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Step 1 — Define rule detail** | **Rule name:** `akto-bedrock-schedule-cf-ACCOUNT_ID`<br>**Description:** `Triggers AKTO Bedrock log processor Lambda function on schedule`<br>**Status:** Enabled · **Event bus:** `default` · **Rule type:** Scheduled rule |
| **Step 2 — Define schedule** | Select the option - ‘A schedule that runs at a regular rate, such as every 10 minutes.’, set it to **10** **minutes**                                                                                                       |
| **Step 3 — Select target(s)** | **AWS service** → **Lambda function** → `akto-bedrock-log-processor-cf-ACCOUNT_ID` Select - 'Create Default role'                                                                                                           |
| **Step 4 — Configure tags** | Optional — skip it                                                                                                                                                                                                          |
| **Step 5 — Review and create** | Confirm *Rule type: Scheduled rule* and *Fixed rate of 10 minute*, then **Create**                                                                                                                                          |

The console adds the invoke permission for you, so no extra step is needed.

> **"Legacy" here does not mean deprecated.** AWS labels these rules legacy to steer new users toward **EventBridge Scheduler** (the **Schedules** item just above it in the nav). Scheduled rules remain fully supported, and they are what this integration uses — the CloudFormation template creates exactly this resource type (`AWS::Events::Rule`).


### CLI

Three commands, in this order — the permission must exist before the target is attached.

```bash
# 1. Create the rule
aws events put-rule \
  --name akto-bedrock-schedule-cf-ACCOUNT_ID \
  --schedule-expression 'rate(10 minutes)' \
  --state ENABLED \
  --description 'Triggers AKTO Bedrock log processor' \
  --region REGION

# 2. Allow EventBridge to invoke the function
aws lambda add-permission \
  --function-name akto-bedrock-log-processor-cf-ACCOUNT_ID \
  --statement-id akto-eventbridge-invoke \
  --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn arn:aws:events:REGION:ACCOUNT_ID:rule/akto-bedrock-schedule-cf-ACCOUNT_ID \
  --region REGION

# 3. Point the rule at the function
aws events put-targets \
  --rule akto-bedrock-schedule-cf-ACCOUNT_ID \
  --targets 'Id=AktoBedrocklambdaTarget,Arn=arn:aws:lambda:REGION:ACCOUNT_ID:function:akto-bedrock-log-processor-cf-ACCOUNT_ID' \
  --region REGION
```

Confirm the rule exists and is enabled:

```bash
aws events list-rules --region REGION \
  --query 'Rules[?ScheduleExpression!=`null`].[Name,ScheduleExpression,State]' --output table
```

> **If the rule already exists** — from an earlier CloudFormation deployment, for instance — `put-rule` silently overwrites it, including re-enabling a rule you had deliberately disabled. Check the list above first, and delete the old rule if you want a clean start:
> ```bash
> aws events remove-targets --rule RULE_NAME --ids AktoBedrocklambdaTarget --region REGION
> aws events delete-rule    --name RULE_NAME --region REGION
> ```

> Keep the 10-minute rate. The function derives its internal work budget from it, so that each run finishes before the next one starts. A shorter interval causes overlapping runs and duplicate data.

---

## Step 9 — Verify

### 1. Run it once by hand

**UI:** Lambda → your function → **Test** tab → **Create new event** (any name, leave `{}` as the body) → **Test**

**CLI:**

```bash
aws lambda invoke \
  --function-name akto-bedrock-log-processor-cf-ACCOUNT_ID \
  --region REGION \
  response.json && cat response.json
```

### 2. Read the logs

```bash
aws logs tail /aws/lambda/akto-bedrock-log-processor-cf-ACCOUNT_ID --follow --region REGION
```

A healthy run opens with its effective configuration:

```
⚙️ Effective configuration:
  ├─ region              us-east-1 (account 041877753357)
  ├─ bedrock logs        s3://acme-bedrock-logs/AWSLogs/
  ├─ checkpoints         s3://acme-akto-markers/akto/markers/
  ├─ akto ingest host    akto.acme.com (api key set)
  └─ lookback            3d s3 / 3d traces
```

Check each line against your intended values — most "it found nothing" reports are a bucket or prefix differing from what was assumed.


### 3. Confirm the checkpoint was written

```bash
aws s3 ls s3://MARKERS_BUCKET/akto/markers/ --recursive
```

Expect `akto/markers/bedrock-logs/manifest.json`, and — if you enabled Step 4 — `akto/markers/agentcore-tracing/manifest.json` as well. Their presence proves the Lambda can both read and write the markers bucket.

### 4. Confirm data reached Akto

Open your Akto dashboard and look for newly discovered agents and conversations. Allow a few minutes.

---
