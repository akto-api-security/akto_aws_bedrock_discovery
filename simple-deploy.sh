#!/bin/bash

# Simple manual deployment script that avoids CloudFormation issues
set -e

echo "🚀 AKTO Bedrock Monitor - Simple Manual Deployment"
echo "================================================="

# Get AWS info
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)
REGION=${REGION:-us-east-1}

echo "📊 Deployment Information:"
echo "   AWS Account ID: $ACCOUNT_ID"
echo "   AWS Region: $REGION"

# Configuration
echo ""
echo "S3 Bucket Configuration:"
echo "  - S3 bucket name is REQUIRED for Bedrock logging"
echo "  - The bucket should already exist and be accessible"
echo "  - Lambda will configure Bedrock to log to this bucket"

# Loop until user provides a bucket name
while [[ -z "$S3_BUCKET_NAME" ]]; do
    read -p "Enter S3 bucket name (required): " S3_BUCKET_NAME
    if [[ -z "$S3_BUCKET_NAME" ]]; then
        echo "❌ S3 bucket name is required. Please provide a bucket name."
    fi
done

echo "✅ Using S3 bucket: $S3_BUCKET_NAME"

# AKTO Data Ingestion Configuration
echo ""
echo "AKTO Data Ingestion Configuration:"
echo "  - Data ingestion service URL is REQUIRED"
echo "  - API key is REQUIRED for authentication"
echo ""

# Loop until user provides data ingestion URL
while [[ -z "$DATA_INGESTION_URL" ]]; do
    read -p "Enter AKTO Data Ingestion URL (e.g., https://your-akto-instance.com:9095/api/ingestData): " DATA_INGESTION_URL
    if [[ -z "$DATA_INGESTION_URL" ]]; then
        echo "❌ Data ingestion URL is required. Please provide the URL."
    fi
done

# Loop until user provides API key
while [[ -z "$AKTO_API_KEY" ]]; do
    read -p "Enter AKTO API Key: " AKTO_API_KEY
    if [[ -z "$AKTO_API_KEY" ]]; then
        echo "❌ AKTO API Key is required. Please provide the API key."
    fi
done

echo "✅ Using Data Ingestion URL: $DATA_INGESTION_URL"
echo "✅ Using API Key: ${AKTO_API_KEY:0:8}..." # Show only first 8 characters for security

echo ""
echo "📦 Building Lambda package..."
cd lambda-function
npm install
zip -r ../akto-bedrock-processor.zip . -x "*.git*" "node_modules/.cache/*"
cd ..
echo "✅ Lambda package created"

# Create IAM role
echo ""
echo "🔧 Creating IAM role..."
ROLE_NAME="akto-bedrock-processor-role-$ACCOUNT_ID"

# Create trust policy
cat > trust-policy.json <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Principal": {
                "Service": "lambda.amazonaws.com"
            },
            "Action": "sts:AssumeRole"
        }
    ]
}
EOF

# Create role
aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document file://trust-policy.json \
    --description "AKTO Bedrock processor role" || echo "Role may already exist"

# Attach basic execution policy
aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

# Create custom policy
cat > custom-policy.json <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "s3:GetObject",
                "s3:GetObjectVersion",
                "s3:ListBucket",
                "s3:CreateBucket",
                "s3:PutBucketPolicy",
                "s3:GetBucketPolicy",
                "s3:PutBucketPublicAccessBlock",
                "s3:PutObject",
                "s3:HeadObject"
            ],
            "Resource": [
                "arn:aws:s3:::*",
                "arn:aws:s3:::*/*"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "bedrock:GetModelInvocationLoggingConfiguration",
                "bedrock:PutModelInvocationLoggingConfiguration",
                "bedrock:GetAgent"
            ],
            "Resource": "*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents"
            ],
            "Resource": "arn:aws:logs:*:*:*"
        },
        {
            "Effect": "Allow",
            "Action": [
                "iam:PassRole",
                "iam:GetRole",
                "iam:CreateRole",
                "iam:AttachRolePolicy"
            ],
            "Resource": [
                "arn:aws:iam::$ACCOUNT_ID:role/*bedrock*",
                "arn:aws:iam::$ACCOUNT_ID:role/service-role/*bedrock*"
            ]
        },
        {
            "Effect": "Allow",
            "Action": [
                "iam:CreateServiceLinkedRole"
            ],
            "Resource": "arn:aws:iam::$ACCOUNT_ID:role/aws-service-role/bedrock.amazonaws.com/*",
            "Condition": {
                "StringEquals": {
                    "iam:AWSServiceName": "bedrock.amazonaws.com"
                }
            }
        }
    ]
}
EOF

POLICY_ARN="arn:aws:iam::$ACCOUNT_ID:policy/akto-bedrock-processor-policy-$ACCOUNT_ID"
aws iam create-policy \
    --policy-name "akto-bedrock-processor-policy-$ACCOUNT_ID" \
    --policy-document file://custom-policy.json \
    --description "AKTO Bedrock processor custom policy" || echo "Policy may already exist"

aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn "$POLICY_ARN"

echo "✅ IAM role created and configured"

# Wait a bit for IAM role to propagate
echo "⏳ Waiting for IAM role to propagate..."
sleep 10

# Delete existing Lambda function if it exists (for cleanup)
FUNCTION_NAME="akto-bedrock-log-processor-$ACCOUNT_ID"
aws lambda delete-function --function-name "$FUNCTION_NAME" --region "$REGION" 2>/dev/null || echo "No existing function to delete"

# Create Lambda function
echo ""
echo "🔧 Creating Lambda function..."
ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$ROLE_NAME"

aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --runtime nodejs22.x \
    --role "$ROLE_ARN" \
    --handler index.handler \
    --timeout 300 \
    --memory-size 1024 \
    --zip-file fileb://akto-bedrock-processor.zip \
    --environment Variables="{DATA_INGESTION_ENDPOINT=$DATA_INGESTION_URL,AKTO_API_KEY=$AKTO_API_KEY,S3_BUCKET_NAME=$S3_BUCKET_NAME,BEDROCK_AWS_REGION=$REGION,AWS_ACCOUNT_ID=$ACCOUNT_ID}" \
    --region "$REGION" || echo "Function may already exist"

# Update function code if it already exists
aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --zip-file fileb://akto-bedrock-processor.zip \
    --region "$REGION"

echo "✅ Lambda function created/updated"

# Create EventBridge rule
echo ""
echo "🔧 Creating EventBridge schedule..."
RULE_NAME="akto-bedrock-schedule-$ACCOUNT_ID"

aws events put-rule \
    --name "$RULE_NAME" \
    --schedule-expression "rate(5 minutes)" \
    --description "Trigger AKTO Bedrock log processor" \
    --state ENABLED \
    --region "$REGION"

# Add Lambda target
LAMBDA_ARN="arn:aws:lambda:$REGION:$ACCOUNT_ID:function:$FUNCTION_NAME"
aws events put-targets \
    --rule "$RULE_NAME" \
    --targets "Id"="1","Arn"="$LAMBDA_ARN" \
    --region "$REGION"

# Add permission for EventBridge to invoke Lambda
aws lambda add-permission \
    --function-name "$FUNCTION_NAME" \
    --statement-id "AllowExecutionFromEventBridge" \
    --action "lambda:InvokeFunction" \
    --principal events.amazonaws.com \
    --source-arn "arn:aws:events:$REGION:$ACCOUNT_ID:rule/$RULE_NAME" \
    --region "$REGION" || echo "Permission may already exist"

echo "✅ EventBridge schedule created"

# Note: S3 bucket should already exist - we don't create it

# Clean up temporary files
rm -f trust-policy.json custom-policy.json akto-bedrock-processor.zip

echo ""
echo "🎉 Deployment completed successfully!"
echo ""
echo "📋 What was created:"
echo "   • Lambda Function: $FUNCTION_NAME"
echo "   • IAM Role: $ROLE_NAME" 
echo "   • EventBridge Rule: $RULE_NAME (runs every 5 minutes)"
echo "   • Using existing S3 Bucket: $S3_BUCKET_NAME"
echo ""
echo "🔍 Next steps:"
echo "1. Generate some AWS Bedrock conversations"
echo "2. Monitor Lambda logs: aws logs tail /aws/lambda/$FUNCTION_NAME --follow"
echo "3. Test manually: aws lambda invoke --function-name $FUNCTION_NAME --payload '{}' response.json"
echo ""
echo "🎯 The system will automatically process Bedrock logs every 5 minutes!"