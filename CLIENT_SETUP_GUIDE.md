# AKTO Bedrock Discovery - CloudFormation Setup Guide

## Overview
AKTO Bedrock Discovery processes your Bedrock model invocation logs and sends conversation data to AKTO for API discovery and security analysis.

---

## Required Inputs (5 Parameters)

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
- **Bedrock AgentCore:** ListHarnesses, GetHarness, ListTagsForResource (discovery only)
- **IAM:** GetRole, ListPolicies (read-only)

---

## Data Flow

```
Your Bedrock Logs Bucket        AKTO Markers Bucket
(READ-ONLY)                      (WRITE-ONLY)
       ↓                              ↑
   [Log Files]                  [Marker Files]
       ↓                              ↑
    ┌──────────────────────────────┐
    │   AKTO Lambda Function       │
    │  • Reads logs every 5 min    │
    │  • Extracts conversations    │
    │  • Marks files as processed  │
    └──────────────────────────────┘
       ↓
    [Send to AKTO]
    (Conversations + API data)
       ↓
    AKTO Dashboard
    (Discovery & Security Analysis)
```

---

## How It Works

1. **You provide:** 2 bucket names, AKTO endpoint, API key
2. **CloudFormation creates:** 
   - Lambda function with restricted IAM permissions
   - EventBridge rule (runs Lambda every 5 minutes)
3. **Lambda on each run:**
   - Reads new log files from logs bucket (READ-ONLY)
   - Extracts conversations and API data
   - Sends to AKTO
   - Writes marker file to markers bucket (WRITE-ONLY)
   - Skips already-processed logs next time
4. **Result:** Your APIs are automatically discovered in AKTO

---

## Prerequisites

✅ **Bedrock Model Invocation Logging:** Enabled  
✅ **Logs S3 Bucket:** Created and Bedrock logging configured  
✅ **Markers S3 Bucket:** Created (empty is fine)  
✅ **AKTO Instance:** Deployed and accessible  
✅ **AKTO API Key:** Generated in AKTO console  

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

---

## After Deployment

Once deployed, Lambda automatically:
- ✅ Processes logs every 5 minutes
- ✅ Extracts conversations from Bedrock logs
- ✅ Sends data to AKTO
- ✅ Tracks processed files with markers
- ✅ Prevents duplicate processing

**No further action needed!** Conversations will appear in your AKTO dashboard automatically.

---

For support: Contact AKTO team
