# AKTO Bedrock Discovery — Client Deployment Guide

This guide covers installing AKTO Bedrock Discovery in your AWS account with one
CloudFormation stack. Once it's installed there is nothing to maintain: the stack keeps
itself on the latest AKTO build.

**Template URL** (AKTO will confirm the current version):

```
https://lambda-code-akto-us-east-1.s3.us-east-1.amazonaws.com/unified_bedrock/v4.5/client-aws-cf-template.yaml
```

## What gets installed

| Resource | Name | Purpose |
|---|---|---|
| Discovery Lambda | `akto-bedrock-log-processor-unified-<account>` | Every 10 min: reads new Bedrock logs and AgentCore traces, sends conversations to AKTO |
| Gateway attacher Lambda* | `akto-bedrock-gw-attacher-cf-<account>` | Finds your AgentCore Gateways and attaches the AKTO interceptor |
| Interceptor Lambda* | `akto-bedrock-interceptor-cf-<account>` | Applies AKTO guardrails to MCP `tools/call` traffic in real time |
| Updater Lambda | `akto-bedrock-updater-<account>-<region>` | Every 15 min: checks whether AKTO published a new build and installs it |
| EventBridge rules, IAM roles | `akto-bedrock-*` | Schedules and least-privilege permissions for the above |

\* Only when `EnableGatewayInterception=true`.

All data stays in your account except the conversations sent to your own AKTO instance
over HTTPS.

## Before you start

1. **Bedrock model invocation logging is on and delivers to S3.**
   ```bash
   aws bedrock get-model-invocation-logging-configuration --region <region>
   ```
   Note the bucket name and key prefix. If it isn't set up, go to Bedrock console →
   Settings → Model invocation logging. The stack doesn't change this setting.

2. **A bucket for AKTO's checkpoint files.** This can be the logs bucket itself (AKTO
   writes only under `akto/markers/`) or a separate, empty bucket.

3. **Your AKTO ingestion endpoint and API key**, for example
   `https://your-akto-instance.com:9095/api/ingestData`.

4. *(Optional)* **AgentCore Harness/Runtime conversations** require CloudWatch
   Transaction Search. Skip this if you don't use AgentCore Harnesses or Runtimes;
   that pipeline simply finds nothing. It is a one-time setting per account and region:
   ```bash
   aws logs put-resource-policy --policy-name AgentCoreTransactionSearchAccess --policy-document '{
     "Version": "2012-10-17",
     "Statement": [{
       "Sid": "TransactionSearchXRayAccess",
       "Effect": "Allow",
       "Principal": {"Service": "xray.amazonaws.com"},
       "Action": "logs:PutLogEvents",
       "Resource": [
         "arn:aws:logs:<region>:<account>:log-group:aws/spans:*",
         "arn:aws:logs:<region>:<account>:log-group:/aws/application-signals/data:*"
       ],
       "Condition": {
         "ArnLike": {"aws:SourceArn": "arn:aws:xray:<region>:<account>:*"},
         "StringEquals": {"aws:SourceAccount": "<account>"}
       }
     }]
   }' --region <region>

   aws xray update-trace-segment-destination --destination CloudWatchLogs --region <region>
   ```
   Or in the console: CloudWatch → Settings → Account → X-Ray traces → Transaction
   Search → Enable. It takes about 10 minutes; `aws xray get-trace-segment-destination`
   should then show `CloudWatchLogs` / `ACTIVE`.

## Parameters

| Parameter | Required | Description |
|---|---|---|
| `LogsBucketName` | Yes | Bucket that Bedrock model invocation logs are delivered to |
| `LogsPrefix` | No | Key prefix of those logs. Default `AWSLogs/` |
| `MarkersBucketName` | Yes | Bucket for AKTO checkpoint files (may be the same as the logs bucket) |
| `DataIngestionEndpoint` | Yes | Your AKTO ingestion URL |
| `AktoApiKey` | Yes | Your AKTO API key (hidden in the console) |
| `RuntimeLogGroupPrefix` | No | AgentCore trace log groups. Default `/aws/bedrock-agentcore/runtimes/` matches AWS's naming |
| `LambdaCodeVersion` | No | Build to start on. Use the version AKTO gives you; the updater keeps it current afterwards |
| `EnableGatewayInterception` | No | `true` (default) adds real-time guardrails on AgentCore Gateways; `false` deploys discovery only |

## Deploy

**Console:** CloudFormation → Create stack → *With new resources* → *Amazon S3 URL* → paste
the template URL → fill in the parameters → tick *I acknowledge that AWS CloudFormation
might create IAM resources with custom names* → Create.

**CLI:**
```bash
aws cloudformation create-stack \
  --stack-name akto-bedrock-discovery \
  --template-url https://lambda-code-akto-us-east-1.s3.us-east-1.amazonaws.com/unified_bedrock/v4.5/client-aws-cf-template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region <region> \
  --parameters \
    ParameterKey=LogsBucketName,ParameterValue=<logs-bucket> \
    ParameterKey=LogsPrefix,ParameterValue=AWSLogs/ \
    ParameterKey=MarkersBucketName,ParameterValue=<markers-bucket> \
    ParameterKey=DataIngestionEndpoint,ParameterValue=https://<your-akto>/api/ingestData \
    ParameterKey=AktoApiKey,ParameterValue=<api-key> \
    ParameterKey=LambdaCodeVersion,ParameterValue=v4.5
```

Deploy it once in each region where you run Bedrock.

## Verify

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# Run discovery once now instead of waiting for the schedule
aws lambda invoke --function-name akto-bedrock-log-processor-unified-$ACCOUNT \
  --region <region> response.json && cat response.json

# Watch its logs
aws logs tail /aws/lambda/akto-bedrock-log-processor-unified-$ACCOUNT --follow --region <region>

# Checkpoints appear after the first run
aws s3 ls s3://<markers-bucket>/akto/markers/ --recursive
```

Then check AKTO for new traffic with source `AWS_BEDROCK`. The first run back-fills the
last 3 days. Later runs pick up only new data.

If interception is on, the `GatewayAttachmentResult` stack output summarises what
happened at deploy time, and `/aws/lambda/akto-bedrock-gw-attacher-cf-<account>` logs
the decision for each gateway.

## Updates

**You don't need to do anything.** Every 15 minutes the updater checks which build AKTO
has published and moves all the AKTO Lambdas to it. The running invocation always
finishes on the old code. You can see the installed build in each Lambda's
`akto:code-version` tag and in the updater's log line.

To change a **parameter** (API key, endpoint, bucket, interception on/off), run
CloudFormation → Update stack → *Use current template* → edit parameters.

## Gateway interception: what it does and how to stop it

- It guards only MCP `tools/call`; `initialize`, `tools/list` and notifications pass
  through untouched.
- **It fails open**: if AKTO is slow (more than 5s) or unreachable, traffic passes
  through.
- If a gateway already has your own interceptor on both REQUEST and RESPONSE, AKTO
  leaves it alone and logs it. If only one point is taken, AKTO uses the free one and
  keeps yours.
- Your gateway's IAM role is never changed. AKTO adds an invoke permission on its own
  interceptor Lambda only.

| Goal | Action |
|---|---|
| Stop attaching to new gateways, keep current ones | `aws events remove-targets --rule akto-bedrock-schedule-cf-<account> --ids AktoGatewayAttacherTarget`. Don't disable the whole rule, because it also runs discovery. The next stack update restores the target |
| Remove interception now, keep the stack | Invoke the attacher with `{"action": "detach-interceptors"}` (the next scheduled run re-attaches) |
| Remove interception permanently | Update the stack with `EnableGatewayInterception=false`. This detaches from every gateway, then deletes the interceptor and attacher |

## Permissions summary

- **Logs bucket**: read only, limited to `LogsPrefix`.
- **Markers bucket**: read/write limited to `akto/markers/`.
- **Bedrock / AgentCore**: list/get agents, harnesses, runtimes, gateways and tags.
  The attacher may also run `UpdateGateway`.
- **IAM**: read-only (`GetRole`, `ListAttachedRolePolicies`, `GetRolePolicy`,
  `GetPolicy`, `GetPolicyVersion`) in your account. The attacher may `PassRole` only to
  `bedrock-agentcore.amazonaws.com`, to re-send the gateway's existing role.
- **CloudWatch Logs**: `FilterLogEvents` limited to `RuntimeLogGroupPrefix`.
  `DescribeLogGroups` is account-wide because AWS can't scope it.
- **Updater**: reads `lambda-code-akto-<region>/unified_bedrock/*` and can update the
  code of this stack's own Lambdas only.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nothing in AKTO | Discovery Lambda logs; does `get-model-invocation-logging-configuration` point at `LogsBucketName`/`LogsPrefix`? |
| `AccessDenied` on S3 | `LogsPrefix` must match where Bedrock writes (e.g. `AWSLogs/` vs `bedrock-logs/`) |
| AgentCore conversations missing | Transaction Search active? Do log groups exist under `RuntimeLogGroupPrefix`? |
| Errors sending to AKTO | Endpoint reachable from the Lambda (VPC/egress)? Is the API key correct? |
| A gateway is not intercepted | Attacher logs. Common causes: gateway not `READY`, both interception points already taken |
| Stack `CREATE_FAILED`: code not found | `LambdaCodeVersion` must be a version AKTO has published in your region |

When contacting AKTO support, include the CloudWatch logs of the Lambda in question.

## Multi-account deployment (AWS Organizations StackSet)

Use this to cover many accounts and regions from the Organization management account
with one deployment, instead of one stack per account. It installs the same Lambdas as
above in every targeted account and region, with three differences:

- **No logs bucket to supply.** Each account's processor reads the bucket from that
  account's own Bedrock logging configuration, so accounts can use different buckets.
- **One central checkpoint bucket** in the management account, with each account
  writing under `<account-id>/<region>/`. Its bucket policy lets every account in your
  organization touch only its own prefix.
- **Optional logging setup** (`BedrockLoggingMode=create`). In accounts with no Bedrock
  logging at all, the processor creates `<BedrockBucketBaseName>-<account>-<region>` and
  turns S3 logging on (text only). An account that already logs to S3 is read as it is.
  An account that logs only to CloudWatch is **never modified**; it is reported as
  skipped and keeps its agent discovery and AgentCore traces.

Files (AKTO will give you the version):
```
https://lambda-code-akto-us-east-1.s3.us-east-1.amazonaws.com/unified_bedrock_stackset/<version>/akto-markers-bucket.yaml
https://lambda-code-akto-us-east-1.s3.us-east-1.amazonaws.com/unified_bedrock_stackset/<version>/client-aws-cf-stackset-template.yaml
```

**1. Enable trusted access for StackSets** (once, in the management account):
CloudFormation console → StackSets → *Activate trusted access with AWS Organizations*.

**2. Create the central markers bucket** as a normal stack in the management account:
```bash
ORG_ID=$(aws organizations describe-organization --query Organization.Id --output text)
aws cloudformation create-stack --stack-name akto-markers-bucket \
  --template-url <akto-markers-bucket.yaml URL> \
  --parameters ParameterKey=OrgId,ParameterValue=$ORG_ID
aws cloudformation wait stack-create-complete --stack-name akto-markers-bucket
aws cloudformation describe-stacks --stack-name akto-markers-bucket \
  --query "Stacks[0].Outputs[?OutputKey=='MarkersBucketName'].OutputValue" --output text
```
The bucket is kept if the stack is deleted, because it holds every account's checkpoints.

**3. Create the StackSet and deploy it to your OUs and regions:**
```bash
aws cloudformation create-stack-set --stack-set-name akto-bedrock \
  --template-url <client-aws-cf-stackset-template.yaml URL> \
  --permission-model SERVICE_MANAGED \
  --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=MarkersBucketName,ParameterValue=<from step 2> \
    ParameterKey=DataIngestionEndpoint,ParameterValue=https://<your-akto>/api/ingestData \
    ParameterKey=AktoApiKey,ParameterValue=<api-key> \
    ParameterKey=BedrockLoggingMode,ParameterValue=discover \
    ParameterKey=LambdaCodeVersion,ParameterValue=<version>

aws cloudformation create-stack-instances --stack-set-name akto-bedrock \
  --deployment-targets OrganizationalUnitIds=<ou-id> \
  --regions us-east-1 \
  --operation-preferences FailureTolerancePercentage=10,MaxConcurrentPercentage=25
```
With auto-deployment on, accounts that later join those OUs get it automatically.

| StackSet parameter | Description |
|---|---|
| `MarkersBucketName` | Output of step 2 |
| `DataIngestionEndpoint`, `AktoApiKey` | As for a single account |
| `BedrockLoggingMode` | `discover` (default): read existing logging, change nothing. `create`: also enable logging where none exists |
| `BedrockBucketBaseName` | Only for `create`, max 35 characters |
| `EnableGatewayInterception` | As for a single account, applied in every account |
| `LogsBucketName` / `LogsPrefix` | Leave blank; only for fleets where every account logs to one shared bucket |
| `RuntimeLogGroupPrefix`, `LambdaCodeVersion` | As for a single account |

**Things to know**
- Service-managed StackSets **don't deploy to the management account itself**. If it
  runs Bedrock too, deploy the single-account template there.
- Each account's logs bucket must be in **that same account**, and not encrypted with a
  customer-managed KMS key.
- All resources are named `akto-bedrock-org-*-<account>-<region>`, so they can't clash
  with a single-account stack.
- **Verify:** `aws s3 ls s3://<markers-bucket>/ --recursive` shows
  `<account>/<region>/bedrock-logs/manifest.json` for each account after its first run
  (within 10 minutes). Each account's processor log says which bucket it discovered, or
  why it skipped.
- **Updates** are automatic in every account, the same as for a single account.
- **Uninstall:** delete the stack instances, then the StackSet, then (optionally) the
  markers bucket.

## Uninstall

Delete the stack. With interception on, the gateway interceptor is detached before the
Lambdas are removed. The checkpoint files under `akto/markers/` are left in your bucket;
delete them if you don't need them.
