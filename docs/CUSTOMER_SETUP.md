# AKTO Bedrock Discovery — Setup

**Time: ~10 minutes. No Lambda. No CloudFormation.**

---

## Step 1 — Turn on Bedrock logging

1. Open **Amazon Bedrock** → **Settings** → **Model invocation logging**
2. Enable it and choose an S3 bucket for delivery

---

## Step 2 — Create an IAM role

### Trust policy

Replace the two placeholders Akto sent you:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "AKTO_HUB_ROLE_ARN" },
    "Action": "sts:AssumeRole",
    "Condition": { "StringEquals": { "sts:ExternalId": "AKTO_EXTERNAL_ID" } }
  }]
}
```

### Permissions policy

Replace `YOUR_ACCOUNT_ID` and `YOUR_LOGS_BUCKET`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:ListBucket"], "Resource": ["arn:aws:s3:::YOUR_LOGS_BUCKET", "arn:aws:s3:::YOUR_LOGS_BUCKET/*"] },
    { "Effect": "Allow", "Action": ["bedrock:GetModelInvocationLoggingConfiguration", "bedrock:ListAgents", "bedrock:GetAgent", "bedrock:ListTagsForResource"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["bedrock-agentcore:ListHarnesses", "bedrock-agentcore:GetHarness", "bedrock-agentcore:ListAgentRuntimes", "bedrock-agentcore:GetAgentRuntime", "bedrock-agentcore:ListTagsForResource"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["iam:ListAttachedRolePolicies"], "Resource": "arn:aws:iam::YOUR_ACCOUNT_ID:role/*" },
    { "Effect": "Allow", "Action": ["logs:DescribeLogGroups", "logs:FilterLogEvents"], "Resource": "arn:aws:logs:*:YOUR_ACCOUNT_ID:log-group:/aws/bedrock-agentcore/runtimes/*" }
  ]
}
```

---

## Step 3 — Send Akto your role ARN

Copy the role ARN from IAM and send it to your Akto contact:

```
arn:aws:iam::YOUR_ACCOUNT_ID:role/YOUR_ROLE_NAME
```

Done.
