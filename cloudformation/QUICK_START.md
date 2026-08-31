# CloudFormation Quick Start Guide

## What is CloudFormation? (Simple Explanation)

Think of CloudFormation as a **blueprint** for building your AWS infrastructure. Instead of clicking buttons in the AWS console or running multiple CLI commands:

- **Old way (shell script):** Run 20+ individual AWS commands that must be executed in exact order
- **New way (CloudFormation):** Write ONE template file that AWS reads and creates everything automatically

It's like the difference between:
- Building a house by individually buying each material and nailing it → **Shell Script**
- Giving a contractor a blueprint that lists everything needed → **CloudFormation**

## Before You Start

### Prerequisites
✅ AWS Account with proper permissions
✅ AWS CLI installed and configured
✅ Node.js 22.x or similar (for building Lambda)
✅ Zip utility
✅ S3 bucket already created (Bedrock logs will be stored here)
✅ AKTO Data Ingestion URL
✅ AKTO API Key

### What You DON'T Need to Do Anymore
❌ Create IAM roles manually
❌ Attach policies one by one
❌ Create Lambda function through console
❌ Set up EventBridge schedule
❌ Remember the order of operations

CloudFormation does all this automatically! ✨

## Step-by-Step Deployment (For Naive Users)

### Step 1: Navigate to CloudFormation Directory
```bash
cd cloudformation
```

### Step 2: Edit Your Environment Parameters
Choose your environment and edit the parameters file:

**For Development:**
```bash
nano parameters/dev-parameters.json
```

**For Production:**
```bash
nano parameters/prod-parameters.json
```

Update these values:
- `S3BucketName`: Your existing S3 bucket
- `DataIngestionEndpoint`: Your AKTO API endpoint
- `AktoApiKey`: Your AKTO authentication key
- `LambdaMemory`: RAM for Lambda (512-1024 recommended)
- `LambdaTimeout`: Max execution time in seconds

**Example:**
```json
[
  {
    "ParameterKey": "S3BucketName",
    "ParameterValue": "my-bedrock-logs"
  },
  {
    "ParameterKey": "DataIngestionEndpoint",
    "ParameterValue": "https://akto.example.com:9095/api/ingestData"
  },
  {
    "ParameterKey": "AktoApiKey",
    "ParameterValue": "sk-1234567890abcdef"
  }
]
```

### Step 3: Make Deployment Script Executable
```bash
chmod +x scripts/deploy.sh
```

### Step 4: Run Deployment
Choose which environment to deploy to:

**Development:**
```bash
./scripts/deploy.sh dev
```

**Production:**
```bash
./scripts/deploy.sh prod
```

**Staging:**
```bash
./scripts/deploy.sh staging
```

### Step 5: Wait for Completion
The script will:
- ✅ Build the Lambda package automatically
- ✅ Create all AWS resources (roles, Lambda, EventBridge)
- ✅ Configure everything with one command
- ✅ Show you the results

**Output Example:**
```
🎉 Deployment completed successfully!

📊 Retrieving stack outputs...
---------
|OutputKey|OutputValue|
---------
|LambdaFunctionName|akto-bedrock-log-processor-123456|
|LambdaFunctionArn|arn:aws:lambda:us-east-1:123456:function:...|
|EventBridgeRuleName|akto-bedrock-schedule-123456|
```

## CloudFormation Template Structure (What It Creates)

The template automatically creates 6 AWS resources:

### 1. IAM Role
```
akto-bedrock-processor-role-{AccountID}
↓
Allows Lambda to access S3, Bedrock, CloudWatch logs, etc.
```

### 2. IAM Policy
```
akto-bedrock-processor-policy-{AccountID}
↓
Grants specific permissions needed
```

### 3. Lambda Function
```
akto-bedrock-log-processor-{AccountID}
↓
Processes Bedrock logs every N minutes
```

### 4. EventBridge Rule
```
akto-bedrock-schedule-{AccountID}
↓
Triggers Lambda automatically (e.g., every 5 minutes)
```

### 5. EventBridge Execution Role
```
Allows EventBridge to invoke Lambda
```

### 6. Lambda Permission
```
Allows EventBridge to call Lambda function
```

### Q: What if something goes wrong during deployment?
**A:** CloudFormation automatically rolls back all changes if there's an error. Everything is cleaned up for you.

### Q: Can I update the configuration later?
**A:** Yes! Just update the parameters file and run the deploy script again. CloudFormation updates only what changed.

### Q: How do I delete everything?
**A:** One command:
```bash
aws cloudformation delete-stack --stack-name akto-bedrock-discovery-prod --region us-east-1
```

### Q: Can I have multiple environments?
**A:** Yes! That's why there are separate parameter files for dev, staging, and prod.

### Q: How do I monitor what CloudFormation is doing?
**A:** Option 1 - CLI:
```bash
aws cloudformation wait stack-create-complete --stack-name akto-bedrock-discovery-prod
```

Option 2 - AWS Console:
Go to CloudFormation → Stacks → Select your stack → View events

## Deploying for the First Time

1. **Prepare** (2 minutes)
   ```bash
   cd cloudformation
   nano parameters/dev-parameters.json  # Edit with your values
   chmod +x scripts/deploy.sh
   ```

2. **Deploy** (2 minutes)
   ```bash
   ./scripts/deploy.sh dev
   ```

3. **Verify** (1 minute)
   ```bash
   # Check Lambda function
   aws lambda list-functions --query 'Functions[?contains(FunctionName, `akto`)]'
   
   # Check EventBridge rule
   aws events list-rules --query 'Rules[?contains(Name, `akto`)]'
   ```

4. **Test** (1 minute)
   ```bash
   # Invoke Lambda manually
   aws lambda invoke --function-name akto-bedrock-log-processor-123456 response.json
   cat response.json
   ```

## File Structure

```
cloudformation/
├── templates/
│   ├── main-template.yaml          ← The blueprint (don't modify)
│   ├── client-aws-cf-template.yaml ← Single account deployment
│   ├── client-aws-cf-stackset-template.yaml  ← Multi-account (StackSet)
│   └── akto-markers-bucket.yaml    ← Central checkpoint bucket (StackSet only)
├── parameters/
│   ├── dev-parameters.json         ← Edit this for dev
│   └── prod-parameters.json        ← Edit this for prod
├── scripts/
│   └── deploy.sh                   ← Run this to deploy
├── QUICK_START.md                  ← This file
```

## Multi-Account Deployment (StackSet)

Everything above deploys into **one** AWS account. To cover every account in an
organization, deploy `client-aws-cf-stackset-template.yaml` as a StackSet instead. One
Lambda then runs per account and region, and all of them checkpoint into a single bucket
in the management account, each under its own `<account-id>/<region>/` prefix.

Single-account deployments are unaffected — `client-aws-cf-template.yaml` is unchanged and
keeps behaving exactly as it does today.

### Step 1: Create the central markers bucket

Deploy **once**, as an ordinary stack, in the management account:

```bash
aws cloudformation create-stack \
  --stack-name akto-markers-bucket \
  --template-body file://templates/akto-markers-bucket.yaml \
  --parameters ParameterKey=OrgId,ParameterValue=o-abcd1234ef
```

Find your organization id with:

```bash
aws organizations describe-organization --query Organization.Id --output text
```

Then take the bucket name from the stack output:

```bash
aws cloudformation describe-stacks --stack-name akto-markers-bucket \
  --query "Stacks[0].Outputs[?OutputKey=='MarkersBucketName'].OutputValue" --output text
```

The bucket policy restricts every account to reading and writing only under its own
account id, so no account can see or overwrite another's checkpoint. It is set to
`Retain`, so deleting the stack does not delete the checkpoints — losing them would make
every account replay its full lookback window and re-send conversations AKTO already has.

### Step 2: Create the StackSet

Service-managed, so AWS creates the roles and new accounts are picked up automatically:

```bash
aws cloudformation create-stack-set \
  --stack-set-name akto-bedrock-processor \
  --template-body file://templates/client-aws-cf-stackset-template.yaml \
  --permission-model SERVICE_MANAGED \
  --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
      ParameterKey=MarkersBucketName,ParameterValue=<from step 1> \
      ParameterKey=DataIngestionEndpoint,ParameterValue=https://your-akto:9095/api/ingestData \
      ParameterKey=AktoApiKey,ParameterValue=<your key> \
      ParameterKey=LambdaCodeVersion,ParameterValue=v3.6
```

### Step 3: Deploy to your OUs

```bash
aws cloudformation create-stack-instances \
  --stack-set-name akto-bedrock-processor \
  --deployment-targets OrganizationalUnitIds=ou-abcd-11111111 \
  --regions us-east-1
```

### Is Bedrock logging already enabled?

`BedrockLoggingMode` decides what happens in accounts that are not yet logging:

| | |
|---|---|
| `discover` (default) | Reads the bucket off each account's existing configuration. Bucket names may differ per account. Nothing is ever created or modified. |
| `create` | Where an account has **no** logging configured at all, creates a bucket and turns S3 logging on. Requires `BedrockBucketBaseName`. |

`create` is safe on a mixed fleet. An account already logging to S3 is read as-is, and an
account logging only to CloudWatch is **skipped and left untouched** — Bedrock keeps one
logging configuration per account, so adding an S3 destination would delete their
CloudWatch one. Those accounts are named in the logs and need S3 logging enabled by hand.

### Before you deploy

The Lambda code must exist in **every region you target** — Lambda requires the code
bucket be in the function's own region:

```bash
aws s3 ls s3://lambda-code-akto-us-east-1/v3.6/akto-bedrock-processor.zip
```

### Checking it worked

```bash
aws s3 ls s3://<markers-bucket>/ --recursive | head
```

Expect one prefix per account and region:

```
111122223333/us-east-1/bedrock-logs/manifest.json
111122223333/us-east-1/agentcore-tracing/manifest.json
444455556666/eu-west-1/bedrock-logs/manifest.json
```

## Next Steps

After deployment:

1. **Generate Bedrock conversations** - Use your Bedrock agents
2. **Monitor logs**:
   ```bash
   aws logs tail /aws/lambda/akto-bedrock-log-processor-cf-123456 --follow
   ```
3. **Check AKTO dashboard** - Verify data is arriving
4. **Adjust as needed** - Update parameters and redeploy if needed

## Troubleshooting

### Issue: "Parameter validation failed"
**Solution:** Check your parameters file JSON syntax. Use a JSON validator.

### Issue: "IAM role not found"
**Solution:** Make sure your AWS user has permission to create IAM roles.

### Issue: "Lambda code not found"
**Solution:** Make sure `akto-bedrock-processor.zip` exists in the parent directory.

### Issue: "Stack creation failed"
**Solution:** Check CloudFormation stack events in AWS console for detailed error message.

## Useful AWS CLI Commands

```bash
# View stack status
aws cloudformation describe-stacks --stack-name akto-bedrock-discovery-prod

# View stack events (what's happening)
aws cloudformation describe-stack-events --stack-name akto-bedrock-discovery-prod

# View Lambda logs
aws logs tail /aws/lambda/akto-bedrock-log-processor-123456 --follow

# Invoke Lambda manually
aws lambda invoke --function-name akto-bedrock-log-processor-123456 response.json

# Delete the stack
aws cloudformation delete-stack --stack-name akto-bedrock-discovery-prod
```

## Security Best Practices

✅ **Never commit API keys** to Git - use AWS Secrets Manager
✅ **Use parameter files** - Keep sensitive data separate
✅ **Enable CloudTrail** - Log all infrastructure changes
✅ **Restrict IAM permissions** - Limit what Lambda can do
✅ **Use environment separation** - Dev/staging/prod stacks


Good luck! 🚀
