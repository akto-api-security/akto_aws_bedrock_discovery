# AKTO Bedrock Discovery — Setup

**Time: ~10 minutes. No Lambda. No CloudFormation.**

---

## Step 1 — Turn on Bedrock logging

1. Open **Amazon Bedrock** → **Settings** → **Model invocation logging**
2. Enable it and choose **S3** delivery (S3 only is enough)
3. Repeat per region if you use Bedrock in multiple regions — each region can point at a different bucket

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

Replace `YOUR_ACCOUNT_ID` and `YOUR_LOGS_BUCKET`. If Bedrock logging uses a **different bucket per region**, duplicate the two S3 `Resource` lines for each bucket.

All actions below are **read-only**.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockModelInvocationLogs",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::YOUR_LOGS_BUCKET",
        "arn:aws:s3:::YOUR_LOGS_BUCKET/*"
      ]
    },
    {
      "Sid": "BedrockDiscovery",
      "Effect": "Allow",
      "Action": [
        "bedrock:GetModelInvocationLoggingConfiguration",
        "bedrock:ListAgents",
        "bedrock:GetAgent",
        "bedrock:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "AgentCoreDiscovery",
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
      "Sid": "AgentRoleInspection",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole",
        "iam:ListAttachedRolePolicies",
        "iam:ListRolePolicies",
        "iam:GetRolePolicy"
      ],
      "Resource": "arn:aws:iam::YOUR_ACCOUNT_ID:role/*"
    },
    {
      "Sid": "PolicyDocumentRead",
      "Effect": "Allow",
      "Action": ["iam:GetPolicy", "iam:GetPolicyVersion"],
      "Resource": [
        "arn:aws:iam::YOUR_ACCOUNT_ID:policy/*",
        "arn:aws:iam::aws:policy/*"
      ]
    },
    {
      "Sid": "AgentCoreCloudWatchTraces",
      "Effect": "Allow",
      "Action": "logs:DescribeLogGroups",
      "Resource": "*"
    },
    {
      "Sid": "AgentCoreCloudWatchTraceRead",
      "Effect": "Allow",
      "Action": "logs:FilterLogEvents",
      "Resource": "arn:aws:logs:*:YOUR_ACCOUNT_ID:log-group:/aws/bedrock-agentcore/runtimes/*"
    }
  ]
}
```

To find which bucket each region uses:

```bash
aws bedrock get-model-invocation-logging-configuration --region <region>
```

Run once per region you use, then add each bucket to the S3 statement.

---

## Step 3 — Send Akto your role ARN

Copy the role ARN from IAM and send it to your Akto contact:

```
arn:aws:iam::YOUR_ACCOUNT_ID:role/YOUR_ROLE_NAME
```

Done.
