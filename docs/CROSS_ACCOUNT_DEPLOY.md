# Cross-Account Hub — Deploy

Deploy once in **your** AWS account. Customer setup is in [CUSTOMER_SETUP.md](./CUSTOMER_SETUP.md).

---

## Architecture

```
Your account                          Customer account(s)
─────────────                         ───────────────────

EventBridge (10 min)
      │
      ▼
akto-bedrock-hub Lambda
      │
      ├─ AssumeRole ──────────────────► Customer IAM role
      │                                      │
      │                                      ├─ S3 (Bedrock logs)
      │                                      ├─ Bedrock / AgentCore APIs
      │                                      └─ CloudWatch traces
      │
      ├─ Scans all regions automatically
      ├─ Runs discovery per active region
      │
      ├─ Markers bucket (your account)
      └─ POST ─────────────────────────► Akto ingestion API
```

You never configure regions or buckets — the Lambda finds them.

---

## Prerequisites

- AWS CLI configured for your hub account
- Node.js 22+ (to build the Lambda zip)
- Akto ingestion endpoint URL + API key
- S3 bucket to host the Lambda zip (can be an existing bucket)

---

## Option A — Deploy script (recommended)

```bash
cd cloudformation/scripts
./deploy-hub.sh
```

The script will:

1. Build `akto-bedrock-processor.zip` (includes the hub handler)
2. Upload it to your S3 code bucket
3. Deploy `hub-template.yaml` via CloudFormation

After deploy, note the stack outputs: **HubRoleArn** and **CrossAccountExternalId**. Send those to the customer with [CUSTOMER_SETUP.md](./CUSTOMER_SETUP.md).

When the customer sends their role ARN:

**Lambda console** → `akto-bedrock-hub-<account-id>` → **Configuration** → **Environment variables** → set **`CROSS_ACCOUNT_ROLE_ARNS`**

```
arn:aws:iam::111111111111:role/AktoBedrockDiscoveryRole
```

Multiple AWS accounts (same customer): comma-separate the ARNs.

---

## Option B — AWS Console

1. Build and upload the zip:

```bash
cd lambda-function
npm ci && npm run package
aws s3 cp ../akto-bedrock-processor.zip s3://YOUR_CODE_BUCKET/path/akto-bedrock-processor.zip
```

2. CloudFormation → **Create stack** → upload `cloudformation/templates/hub-template.yaml`

3. Parameters:

| Parameter | Value |
|-----------|-------|
| MarkersBucketName | e.g. `akto-hub-markers` |
| DataIngestionEndpoint | Your Akto ingest URL |
| AktoApiKey | Your Akto API key |
| CrossAccountExternalId | Pick a secret (e.g. `akto-bedrock-2026`) |
| CrossAccountRoleArns | Leave empty until customer sends their ARN |
| ProcessorCodeBucket | Your code bucket |
| ProcessorCodeKey | S3 key where you uploaded the zip |

4. Set `CROSS_ACCOUNT_ROLE_ARNS` on the Lambda when the customer replies (same as Option A).

---

## Option C — AWS CLI

```bash
cd lambda-function && npm ci && npm run package && cd ..

aws s3 cp akto-bedrock-processor.zip s3://YOUR_CODE_BUCKET/path/akto-bedrock-processor.zip

aws cloudformation deploy \
  --stack-name akto-bedrock-hub \
  --template-file cloudformation/templates/hub-template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    MarkersBucketName=akto-hub-markers \
    DataIngestionEndpoint=https://your-akto.com:9095/api/ingestData \
    AktoApiKey=your-key \
    CrossAccountExternalId=akto-bedrock-2026 \
    CrossAccountRoleArns= \
    ProcessorCodeBucket=YOUR_CODE_BUCKET \
    ProcessorCodeKey=path/akto-bedrock-processor.zip
```

---

## Verify

```bash
aws cloudformation describe-stacks --stack-name akto-bedrock-hub \
  --query 'Stacks[0].Outputs'
```

After setting `CROSS_ACCOUNT_ROLE_ARNS`, invoke once manually:

```bash
aws lambda invoke \
  --function-name akto-bedrock-hub-$(aws sts get-caller-identity --query Account --output text) \
  response.json && cat response.json
```

Check Akto dashboard for traffic within ~10 minutes.
