#!/bin/bash
# Deploy the cross-account hub stack (hub-template.yaml).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$SCRIPT_DIR/../templates/hub-template.yaml"
STACK_NAME="${STACK_NAME:-akto-bedrock-hub}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)
REGION=${REGION:-us-east-1}

echo "AKTO Bedrock Hub Deploy"
echo "======================="
echo "Account: $ACCOUNT_ID  Region: $REGION"
echo ""

read -p "Markers bucket name: " MARKERS_BUCKET
read -p "Lambda code S3 bucket: " CODE_BUCKET
read -p "Lambda code S3 key [unified_bedrock/hub/akto-bedrock-processor.zip]: " CODE_KEY
CODE_KEY=${CODE_KEY:-unified_bedrock/hub/akto-bedrock-processor.zip}
read -p "Akto ingestion endpoint: " DATA_INGESTION_ENDPOINT
read -sp "Akto API key: " AKTO_API_KEY; echo ""
read -p "Cross-account External ID: " CROSS_ACCOUNT_EXTERNAL_ID
read -p "Customer role ARN(s) [optional, comma-separated]: " CROSS_ACCOUNT_ROLE_ARNS

echo ""
echo "Building Lambda package..."
cd "$REPO_ROOT/lambda-function"
npm ci
npm run package

echo "Uploading to s3://$CODE_BUCKET/$CODE_KEY ..."
aws s3 cp "$REPO_ROOT/akto-bedrock-processor.zip" "s3://$CODE_BUCKET/$CODE_KEY" --region "$REGION"

echo "Deploying CloudFormation stack: $STACK_NAME ..."
aws cloudformation deploy \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE" \
  --region "$REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    MarkersBucketName="$MARKERS_BUCKET" \
    DataIngestionEndpoint="$DATA_INGESTION_ENDPOINT" \
    AktoApiKey="$AKTO_API_KEY" \
    CrossAccountExternalId="$CROSS_ACCOUNT_EXTERNAL_ID" \
    CrossAccountRoleArns="$CROSS_ACCOUNT_ROLE_ARNS" \
    ProcessorCodeBucket="$CODE_BUCKET" \
    ProcessorCodeKey="$CODE_KEY"

echo ""
echo "Stack outputs:"
aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' --output table

echo ""
echo "Send HubRoleArn + CrossAccountExternalId to the customer (see docs/CUSTOMER_SETUP.md)."
if [[ -z "$CROSS_ACCOUNT_ROLE_ARNS" ]]; then
  echo "When they reply with their role ARN, set CROSS_ACCOUNT_ROLE_ARNS on the Lambda."
fi
