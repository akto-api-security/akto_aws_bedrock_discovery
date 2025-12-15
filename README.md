# AKTO AWS Bedrock Monitoring - Client Solution

🎯 **Self-contained AWS Bedrock conversation monitoring for your AWS account**

## Quick Overview

This solution automatically monitors AWS Bedrock agent conversations and sends them to your AKTO instance for security analysis. Everything runs in your AWS account with complete data isolation.

## What You Get

✅ **Automated Monitoring** - Captures all AWS Bedrock conversations  
✅ **Real-time Processing** - Processes logs every 5 minutes  
✅ **Multi-Model Support** - Works with Amazon Nova, Claude, and other models  
✅ **Security Analysis** - Integrates with AKTO for threat detection  
✅ **Complete Privacy** - All data stays in your AWS account  

## Architecture

```
AWS Bedrock → S3 Logs → EventBridge (5min) → Lambda → AKTO Data Ingestion
```

## Quick Start

### Prerequisites
- AWS CLI configured with appropriate permissions
- AKTO instance with data ingestion service 
- AKTO API key

### 1-Minute Setup

```bash
# 1. Clone and navigate
git clone https://github.com/akto-api-security/akto_aws_bedrock_discovery.git
cd akto_aws_bedrock_discovery

# 2. Make executable
chmod +x simple-deploy.sh

# 3. Run deployment
./simple-deploy.sh
```

The script will prompt for:
- **S3 Bucket Name** (for storing Bedrock logs)
- **AKTO Data Ingestion URL** (e.g., `https://your-akto.com:9095/api/ingestData`)
- **AKTO API Key** (for authentication)

### What Gets Created

| Resource | Purpose |
|----------|---------|
| **Lambda Function** | Processes Bedrock logs every 5 minutes |
| **EventBridge Rule** | Triggers Lambda on schedule |
| **IAM Role** | Provides necessary permissions |
| **S3 Bucket** | Stores Bedrock conversation logs |

## How It Works

### 1. Automatic Configuration
- Lambda auto-configures AWS Bedrock logging to S3
- Sets up model invocation logging for all supported models

### 2. Scheduled Processing
- EventBridge triggers Lambda every 5 minutes
- Lambda reads new log files from S3
- Extracts conversation pairs from compressed logs

### 3. Multi-Model Support
- **Amazon Nova Models**: `amazon.nova-lite-v1:0`, `amazon.nova-pro-v1:0`
- **Claude Models**: `anthropic.claude-3-*`
- **Automatic Detection**: Handles different content formats

### 4. AKTO Integration
- Formats conversations in AKTO StandardMessage format
- Includes security tags: `{"source": "AWS_BEDROCK", "gen-ai": "Gen AI"}`
- Sends with X-API-KEY authentication

## Sample Data Format

Conversations are sent to AKTO in this format:
```json
{
  "path": "/bedrock/invoke",
  "method": "POST",
  "requestHeaders": "{\"X-Bedrock-Model-Id\":\"amazon.nova-lite-v1:0\",\"aws-account-id\":\"123456789012\"}",
  "requestPayload": "{\"userMessage\":\"Hello\",\"model\":\"amazon.nova-lite-v1:0\"}",
  "responsePayload": "{\"message\":\"Hi there! How can I help?\",\"model\":\"amazon.nova-lite-v1:0\"}",
  "statusCode": "200",
  "tag": "{\"source\":\"AWS_BEDROCK\",\"gen-ai\":\"Gen AI\"}",
  "time": "1734254000"
}
```

## Testing

### Generate Test Conversation
```bash
# Example Bedrock API call
aws bedrock-runtime invoke-model \
    --model-id anthropic.claude-3-haiku-20240307-v1:0 \
    --body '{"messages":[{"role":"user","content":[{"type":"text","text":"Hello, this is a test."}]}],"max_tokens":50,"anthropic_version":"bedrock-2023-05-31"}' \
    --content-type application/json \
    output.json
```

### Monitor Processing
```bash
# Check Lambda logs
aws logs tail /aws/lambda/akto-bedrock-log-processor-YOUR_ACCOUNT_ID --follow

# Check S3 for new logs
aws s3 ls s3://your-bucket-name/bedrock-logs/ --recursive

# Test Lambda manually
aws lambda invoke --function-name akto-bedrock-log-processor-YOUR_ACCOUNT_ID --payload '{}' response.json
```

### Verify in AKTO
1. Check your AKTO dashboard for new API traffic
2. Look for requests to `/bedrock/invoke`
3. Verify tags show `gen-ai: Gen AI` and `source: AWS_BEDROCK`

## Troubleshooting

### Common Issues

**Lambda Not Processing**
```bash
# Check EventBridge rule
aws events describe-rule --name akto-bedrock-schedule-YOUR_ACCOUNT_ID

# Check Lambda permissions
aws lambda get-policy --function-name akto-bedrock-log-processor-YOUR_ACCOUNT_ID
```

**No Bedrock Logs in S3**
```bash
# Check Bedrock logging configuration
aws bedrock get-model-invocation-logging-configuration

# Check S3 bucket exists
aws s3 ls s3://your-bucket-name
```

**AKTO Connection Issues**
```bash
# Test AKTO endpoint
curl -X POST "https://your-akto.com:9095/api/ingestData" \
     -H "Content-Type: application/json" \
     -H "X-API-KEY: your-api-key" \
     -d '{"test": "connection"}'
```



## Security & Privacy

### Data Protection
- All conversation data stays in your AWS account
- Lambda processes data without storing permanently
- S3 bucket uses server-side encryption
- Network traffic uses HTTPS/TLS

### IAM Permissions
The solution uses minimal required permissions:
- Bedrock: Configure logging
- S3: Read log files
- Lambda: Basic execution
- EventBridge: Trigger function

### Cost Optimization
- EventBridge: ~$1/month for scheduling
- Lambda: ~$0.20/month for processing
- S3: ~$0.02/month for log storage
- **Total: ~$1.25/month**

## File Structure

```
akto_aws_bedrock_discovery/
├── README.md                    # This quick start guide
├── CLIENT_SETUP_GUIDE.md        # Detailed setup instructions
├── simple-deploy.sh             # One-click deployment script
├── test-solution.sh             # Verification script
└── lambda-function/
    ├── index.js                 # Main Lambda function
    ├── package.json             # Dependencies
    └── package-lock.json        # Dependency lock file
```

## Support

📚 **Detailed Setup**: See [CLIENT_SETUP_GUIDE.md](CLIENT_SETUP_GUIDE.md)  
📧 **Support**: Contact AKTO support with Lambda logs for assistance  

---

🎉 **Start monitoring your AWS Bedrock conversations in under 2 minutes!**