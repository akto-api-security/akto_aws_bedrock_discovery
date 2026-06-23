#!/bin/bash

# CloudFormation Deployment Script for AKTO Bedrock Discovery
# This script deploys the infrastructure using CloudFormation instead of manual CLI commands

set -e

echo "🚀 AKTO Bedrock Monitor - CloudFormation Deployment"
echo "=================================================="
echo ""

# Get AWS info
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)
REGION=${REGION:-us-east-1}

echo "📊 AWS Information:"
echo "   Account ID: $ACCOUNT_ID"
echo "   Region: $REGION"
echo ""

# Determine environment (default to prod)
ENVIRONMENT=${1:-prod}

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(dev|staging|prod)$ ]]; then
    echo "❌ Invalid environment. Must be: dev, staging, or prod"
    echo "Usage: ./deploy.sh [dev|staging|prod]"
    exit 1
fi

echo "📋 Environment: $ENVIRONMENT"
echo ""

# Set parameters file and stack name based on environment
PARAMS_FILE="parameters/${ENVIRONMENT}-parameters.json"
STACK_NAME="akto-bedrock-discovery-${ENVIRONMENT}"
TEMPLATE_FILE="templates/main-template.yaml"

# Check if files exist
if [[ ! -f "$TEMPLATE_FILE" ]]; then
    echo "❌ Template file not found: $TEMPLATE_FILE"
    exit 1
fi

if [[ ! -f "$PARAMS_FILE" ]]; then
    echo "❌ Parameters file not found: $PARAMS_FILE"
    exit 1
fi

echo "📝 Configuration:"
echo "   Stack Name: $STACK_NAME"
echo "   Template: $TEMPLATE_FILE"
echo "   Parameters: $PARAMS_FILE"
echo ""

# Ask user to review and confirm parameters
echo "⚠️  Please review the parameters in $PARAMS_FILE"
echo "   Edit the file with your actual values before continuing!"
echo ""
read -p "Have you updated the parameters file? (yes/no): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy][Ee][Ss]?$ ]]; then
    echo "❌ Deployment cancelled. Please update parameters file and try again."
    exit 1
fi

# Extract S3 bucket name from parameters file
S3_BUCKET_NAME=$(grep -A 1 '"ParameterKey": "S3BucketName"' "$PARAMS_FILE" | grep ParameterValue | sed 's/.*"ParameterValue": "\([^"]*\)".*/\1/')

if [[ -z "$S3_BUCKET_NAME" ]]; then
    echo "❌ Could not find S3BucketName in parameters file: $PARAMS_FILE"
    exit 1
fi

echo "🪣 S3 Bucket: $S3_BUCKET_NAME"
echo ""

# Build Lambda package (always rebuild to get latest code)
LAMBDA_ZIP="../akto-bedrock-processor.zip"
echo ""
echo "📦 Building Lambda package..."
cd ../lambda-function
npm install
zip -r ../akto-bedrock-processor.zip . -x "*.git*" "node_modules/.cache/*"
cd ../cloudformation
echo "✅ Lambda package built successfully"

# Upload Lambda package to S3 so CloudFormation can access it
echo ""
echo "📤 Uploading Lambda package to S3 (5.4 MB, may take 1-2 minutes)..."
aws s3 cp "$LAMBDA_ZIP" "s3://$S3_BUCKET_NAME/lambda-code/akto-bedrock-processor.zip" --region "$REGION"
if [[ $? -eq 0 ]]; then
    echo "✅ Lambda package uploaded to S3: s3://$S3_BUCKET_NAME/lambda-code/akto-bedrock-processor.zip"
else
    echo "❌ Error uploading Lambda package to S3. Please check your S3 permissions."
    exit 1
fi

echo ""

# Step 1: ALWAYS update Lambda code first (regardless of CloudFormation status)
LAMBDA_FUNCTION_NAME="akto-bedrock-log-processor-cf-${ACCOUNT_ID}"
echo ""
echo "🔧 Updating Lambda function code: $LAMBDA_FUNCTION_NAME"

LAMBDA_UPDATE=$(aws lambda update-function-code \
    --function-name "$LAMBDA_FUNCTION_NAME" \
    --s3-bucket "$S3_BUCKET_NAME" \
    --s3-key "lambda-code/akto-bedrock-processor.zip" \
    --region "$REGION" 2>&1)

if echo "$LAMBDA_UPDATE" | grep -q "FunctionArn\|LastModified"; then
    LAST_MODIFIED=$(echo "$LAMBDA_UPDATE" | grep -o '"LastModified":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo "✅ Lambda function code updated successfully!"
    echo "   Last Modified: $LAST_MODIFIED"
else
    echo "❌ Failed to update Lambda function code"
    echo "Error: $LAMBDA_UPDATE"
    exit 1
fi

# Step 2: Update CloudFormation stack (if it exists)
echo ""
STACK_EXISTS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" 2>/dev/null || echo "")

if [[ -z "$STACK_EXISTS" ]]; then
    # Create new stack
    echo "🔧 Creating CloudFormation stack: $STACK_NAME"
    aws cloudformation create-stack \
        --stack-name "$STACK_NAME" \
        --template-body "file://$TEMPLATE_FILE" \
        --parameters "file://$PARAMS_FILE" \
        --capabilities CAPABILITY_NAMED_IAM \
        --region "$REGION" \
        --tags \
            Key=Application,Value=AKTO-Bedrock-Discovery \
            Key=Environment,Value=$ENVIRONMENT \
            Key=ManagedBy,Value=CloudFormation

    echo "⏳ Waiting for stack creation to complete..."
    aws cloudformation wait stack-create-complete \
        --stack-name "$STACK_NAME" \
        --region "$REGION"

    echo "✅ Stack created successfully!"
else
    # Update existing stack
    echo "🔧 Updating CloudFormation stack: $STACK_NAME"
    UPDATE_OUTPUT=$(aws cloudformation update-stack \
        --stack-name "$STACK_NAME" \
        --template-body "file://$TEMPLATE_FILE" \
        --parameters "file://$PARAMS_FILE" \
        --capabilities CAPABILITY_NAMED_IAM \
        --region "$REGION" \
        --tags \
            Key=Application,Value=AKTO-Bedrock-Discovery \
            Key=Environment,Value=$ENVIRONMENT \
            Key=ManagedBy,Value=CloudFormation 2>&1)

    if echo "$UPDATE_OUTPUT" | grep -q "No updates are to be performed"; then
        echo "ℹ️  No CloudFormation template changes"
    elif echo "$UPDATE_OUTPUT" | grep -q "StackId"; then
        echo "⏳ Waiting for stack update to complete..."
        aws cloudformation wait stack-update-complete \
            --stack-name "$STACK_NAME" \
            --region "$REGION" 2>/dev/null || true
        echo "✅ Stack updated successfully!"
    else
        echo "⚠️  CloudFormation update: $UPDATE_OUTPUT"
    fi
fi

echo ""
echo "📊 Retrieving stack outputs..."
OUTPUTS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query 'Stacks[0].Outputs' \
    --output table)

echo "$OUTPUTS"

echo ""
echo "🎉 Deployment completed successfully!"
echo ""
echo "🔍 Next steps:"
echo "1. Generate some AWS Bedrock conversations"
echo "2. Monitor Lambda logs:"
echo "   aws logs tail /aws/lambda/akto-bedrock-log-processor-${ACCOUNT_ID} --follow --region $REGION"
echo "3. Test manually:"
echo "   aws lambda invoke --function-name akto-bedrock-log-processor-${ACCOUNT_ID} --region $REGION response.json"
echo ""
echo "📌 CloudFormation Stack Information:"
echo "   Stack Name: $STACK_NAME"
echo "   Region: $REGION"
echo "   Environment: $ENVIRONMENT"
echo ""
echo "To delete the stack:"
echo "   aws cloudformation delete-stack --stack-name $STACK_NAME --region $REGION"
