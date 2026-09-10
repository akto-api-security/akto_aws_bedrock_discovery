# Lambda Versioning with CloudFormation

## What We Implemented

Added **automatic Lambda versioning** to the CloudFormation template. Every time you deploy, a new immutable version is created and the `LIVE` alias points to it.

---

## Changes Made to CloudFormation

### **1. Enable AutoPublishAlias**

In `AktoBedrocklambdaFunction`, added one line:

```yaml
AktoBedrocklambdaFunction:
  Type: AWS::Lambda::Function
  Properties:
    FunctionName: !Sub 'akto-bedrock-log-processor-cf-${AWS::AccountId}'
    Runtime: nodejs22.x
    Handler: index.handler
    Role: !GetAtt LambdaExecutionRole.Arn
    Timeout: 300
    MemorySize: 1024
    Code:
      S3Bucket: !Sub 'lambda-code-akto-${AWS::Region}'
      S3Key: 'akto-bedrock-processor.zip'
    AutoPublishAlias: LIVE        # ← ADDED THIS
    Environment:
      Variables:
        # ... env vars ...
```

### **2. Update EventBridge to Use LIVE Alias**

Changed EventBridge target to invoke the `LIVE` alias (not the function directly):

```yaml
Targets:
  - Arn: !Sub '${AktoBedrocklambdaFunction.Arn}:LIVE'  # ← UPDATED
    Id: AktoBedrocktambdaTarget
    RoleArn: !GetAtt EventBridgeExecutionRole.Arn
```

---

## How It Works

### **On Each Deployment**

```
Deploy 1:
  ✅ CloudFormation updates Lambda code
  ✅ AutoPublishAlias creates Version 1
  ✅ LIVE alias → points to Version 1
  ✅ EventBridge runs Version 1 (via LIVE alias)

Deploy 2:
  ✅ CloudFormation updates Lambda code
  ✅ AutoPublishAlias creates Version 2
  ✅ LIVE alias → points to Version 2 (automatically updated)
  ✅ EventBridge runs Version 2 (via LIVE alias)

Deploy 3:
  ✅ CloudFormation updates Lambda code
  ✅ AutoPublishAlias creates Version 3
  ✅ LIVE alias → points to Version 3 (automatically updated)
  ✅ EventBridge runs Version 3 (via LIVE alias)
```

---

## Benefits

✅ **Automatic Versioning**: Every deployment creates an immutable version  
✅ **No Manual Steps**: All done through CFT  
✅ **Infrastructure as Code**: Versioning is code, not manual  
✅ **Rollback Safety**: Can revert to previous version if needed  
✅ **Audit Trail**: See exactly what changed in each version  
✅ **Decoupling**: EventBridge doesn't hardcode version numbers  

---

## Checking Versions in AWS Console

### **View All Versions**
```
AWS Console → Lambda → Functions → akto-bedrock-log-processor-cf-{account}
→ Qualifiers tab → View all versions
```

You'll see:
- Version 1, 2, 3, etc. (immutable snapshots)
- LIVE alias (points to latest)
- $LATEST (current editable version)

### **View Version Details**
```
Click on a version → See exact Code, Environment, Configuration
```

---

## Rolling Back to Previous Version

If a deployment breaks, revert by updating the CloudFormation to point to an older version:

**Option 1: Revert to Previous Code** (automatic on next deploy)
```bash
# Revert your code changes in git
git revert <commit-hash>

# Deploy CFT again
aws cloudformation deploy ...
# This creates a new version that matches the previous code
```

**Option 2: Manually Point LIVE Alias to Older Version** (if urgent)
```bash
aws lambda update-alias \
  --function-name akto-bedrock-log-processor-cf-{account} \
  --name LIVE \
  --function-version 5  # Point back to Version 5
```

---

## Query Versions from AWS CLI

```bash
# List all versions
aws lambda list-versions-by-function \
  --function-name akto-bedrock-log-processor-cf-{account}

# Get LIVE alias details
aws lambda get-alias \
  --function-name akto-bedrock-log-processor-cf-{account} \
  --name LIVE

# Get specific version details
aws lambda get-function \
  --function-name akto-bedrock-log-processor-cf-{account}:3
```

---

## Summary

| Before | After |
|--------|-------|
| $LATEST (always changes) | Version 1, 2, 3... (immutable) + LIVE alias |
| Manual tracking | Automatic via CFT |
| Hard to rollback | Easy rollback to any version |
| No audit trail | Full version history |

**Everything is now Infrastructure as Code!** ✅
