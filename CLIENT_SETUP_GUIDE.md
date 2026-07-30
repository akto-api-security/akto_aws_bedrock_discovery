# AKTO Bedrock Discovery - CloudFormation Setup Guide

## Overview
AKTO Bedrock Discovery runs two independent pipelines in one Lambda: Bedrock Agent
Classic (from S3 model invocation logs) and AgentCore Harness/Runtime (from CloudWatch
observability traces). Both send conversation data to AKTO for API discovery and
security analysis. The AgentCore half is a no-op — it simply finds nothing to process —
if you haven't separately enabled CloudWatch Transaction Search + tracing on your
AgentCore resources.

---

## Required Inputs (5 Parameters, 1 Optional)

### 1. **LogsBucketName** ⭐ Required
**What:** S3 bucket name where Bedrock stores its model invocation logs  
**Example:** `my-bedrock-logs`  
**Why:** Lambda reads log files from this bucket  
**Where to find:** Check AWS Bedrock console → Model Invocation Logging Configuration

### 2. **LogsPrefix** (Optional)
**What:** S3 folder prefix where logs are stored  
**Example:** `AWSLogs/` (default) or `bedrock-logs/`  
**Why:** Restricts Lambda to read only from this specific prefix  
**Default:** `AWSLogs/` (AWS default folder for Bedrock logs)

### 3. **MarkersBucketName** ⭐ Required
**What:** Separate S3 bucket for AKTO internal tracking files  
**Example:** `akto-markers`  
**Why:** 
- Keeps logs separate from AKTO metadata
- Lambda writes "marker" files here to track processed logs
- Prevents reprocessing same logs on each run  
**Note:** Create this bucket beforehand (can be empty)

### 4. **DataIngestionEndpoint** ⭐ Required
**What:** URL to your AKTO instance's data ingestion API  
**Example:** `https://your-akto-instance.com:9095/api/ingestData`  
**Why:** Lambda sends discovered conversations and API data to this endpoint

### 5. **AktoApiKey** ⭐ Required
**What:** API key for authenticating with AKTO  
**Why:** Lambda uses this to authenticate requests to AKTO

### 6. **RuntimeLogGroupPrefix** (Optional)
**What:** CloudWatch log group prefix for AgentCore Harness/Runtime observability traces  
**Example:** `/aws/bedrock-agentcore/runtimes/` (default — matches AWS's own naming)  
**Why:** Scopes what the AgentCore trace pipeline is allowed to read  
**Note:** Only relevant if you have AgentCore Harnesses/Runtimes with CloudWatch tracing enabled

---

## Permission Restrictions (Security Model)

### **Logs Bucket - READ-ONLY**
```
Permissions: GetObject, ListBucket, HeadObject
Scope:      s3://LogsBucketName/LogsPrefix/*
✅ Can read log files
❌ Cannot modify or delete logs
```

### **Markers Bucket - WRITE-ONLY (akto/ prefix only)**
```
Permissions: PutObject, HeadObject, ListBucket
Scope:      s3://MarkersBucketName/akto/markers/*
✅ Can write marker tracking files
❌ Cannot read your data
❌ Cannot write outside akto/markers/ prefix
```

### **AWS Services - Limited**
- **Bedrock:** GetAgent, ListTagsForResource (metadata only)
- **Bedrock AgentCore:** ListHarnesses, GetHarness, ListAgentRuntimes, GetAgentRuntime, ListTagsForResource (discovery only)
- **IAM:** ListAttachedRolePolicies (read-only)
- **CloudWatch Logs:** DescribeLogGroups (account-wide listing — AWS doesn't support scoping this one), FilterLogEvents (read-only, scoped to the AgentCore observability log group prefix only)

---

## Data Flow

```
Your Bedrock Logs Bucket        AKTO Markers Bucket        AgentCore CloudWatch Logs
(READ-ONLY)                      (WRITE-ONLY)                (READ-ONLY, optional)
       ↓                              ↑                              ↓
   [Log Files]                  [Marker Files]              [Observability Traces]
       ↓                              ↑                              ↓
    ┌────────────────────────────────────────────────────────────────────┐
    │                      AKTO Lambda Function                          │
    │  • Bedrock Agent Classic: reads S3 logs, extracts conversations    │
    │  • AgentCore Harness/Runtime: reads CloudWatch traces (if enabled) │
    │  • Both: send to AKTO, checkpoint their own marker file            │
    └────────────────────────────────────────────────────────────────────┘
       ↓
    [Send to AKTO]
    (Conversations + API data)
       ↓
    AKTO Dashboard
    (Discovery & Security Analysis)
```

---

## How It Works

1. **You provide:** 2 bucket names, AKTO endpoint, API key (+ optionally a CloudWatch log group prefix)
2. **CloudFormation creates:** 
   - Lambda function with restricted IAM permissions
   - EventBridge rule (runs Lambda every 10 minutes)
3. **Lambda on each run:**
   - Reads new log files from logs bucket (READ-ONLY), extracts Bedrock Agent Classic conversations, sends to AKTO, writes its marker file (WRITE-ONLY)
   - Separately, reads new CloudWatch trace events for AgentCore Harnesses/Runtimes (if tracing is enabled), sends to AKTO, writes its own marker file
   - Skips already-processed data next time, for both pipelines independently
4. **Result:** Your APIs are automatically discovered in AKTO

---

## Prerequisites

✅ **Bedrock Model Invocation Logging:** Enabled  
✅ **Logs S3 Bucket:** Created and Bedrock logging configured  
✅ **Markers S3 Bucket:** Created (empty is fine)  
✅ **AKTO Instance:** Deployed and accessible  
✅ **AKTO API Key:** Generated in AKTO console  
⬜ **AgentCore CloudWatch Transaction Search + tracing:** Optional — only needed if you
   want Harness/Runtime conversations too. Enabled separately, per Harness/Runtime, in the
   AWS console; this stack doesn't turn it on for you and works fine without it.

---

## Security Guarantees

| Aspect | Guarantee |
|--------|-----------|
| **Log Integrity** | Lambda cannot delete or modify logs |
| **Data Isolation** | Marker files separate from logs (different bucket) |
| **Scope Restriction** | Access limited to specific buckets/prefixes |
| **No Lateral Movement** | Cannot access other AWS resources |
| **Audit Trail** | All access logged in CloudTrail |

---

## Deployment

Deploy via AWS CloudFormation console or AWS CLI:

```bash
aws cloudformation create-stack \
  --stack-name akto-bedrock-discovery \
  --template-body file://client-aws-cf-template.yaml \
  --parameters \
    ParameterKey=LogsBucketName,ParameterValue=my-bedrock-logs \
    ParameterKey=LogsPrefix,ParameterValue=AWSLogs/ \
    ParameterKey=MarkersBucketName,ParameterValue=akto-markers \
    ParameterKey=DataIngestionEndpoint,ParameterValue=https://your-akto-instance.com:9095/api/ingestData \
    ParameterKey=AktoApiKey,ParameterValue=your-api-key \
  --region us-east-1 \
  --capabilities CAPABILITY_NAMED_IAM
```

`RuntimeLogGroupPrefix` isn't passed above since its default already matches AWS's own
naming — add `ParameterKey=RuntimeLogGroupPrefix,ParameterValue=...` only if yours differs.

---

## After Deployment

Once deployed, Lambda automatically:
- ✅ Runs every 10 minutes
- ✅ Extracts conversations from Bedrock Agent Classic S3 logs
- ✅ Extracts conversations from AgentCore Harness/Runtime CloudWatch traces (if tracing is enabled)
- ✅ Sends data to AKTO
- ✅ Tracks processed data with markers, independently per pipeline
- ✅ Prevents duplicate processing

**No further action needed!** Conversations will appear in your AKTO dashboard automatically.

---

For support: Contact AKTO team
