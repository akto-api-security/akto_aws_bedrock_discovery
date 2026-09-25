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

# Defaults — override via env if needed
MARKERS_BUCKET="${MARKERS_BUCKET:-akto-bedrock-hub-${ACCOUNT_ID}}"
CODE_BUCKET="$MARKERS_BUCKET"
CODE_KEY="${CODE_KEY:-lambda/akto-bedrock-processor.zip}"
CROSS_ACCOUNT_EXTERNAL_ID="${CROSS_ACCOUNT_EXTERNAL_ID:-akto-bedrock-hub-${ACCOUNT_ID}}"
CROSS_ACCOUNT_ROLE_ARNS="${CROSS_ACCOUNT_ROLE_ARNS:-}"

echo "AKTO Bedrock Hub Deploy"
echo "======================="
echo "Account: $ACCOUNT_ID  Region: $REGION"
echo "Bucket:  s3://$MARKERS_BUCKET  (auto-created if missing)"
echo "External ID: $CROSS_ACCOUNT_EXTERNAL_ID"
echo ""

if [[ -z "$DATA_INGESTION_ENDPOINT" ]]; then
  read -p "Akto ingestion endpoint: " DATA_INGESTION_ENDPOINT
fi
if [[ -z "$AKTO_API_KEY" ]]; then
  read -sp "Akto API key: " AKTO_API_KEY; echo ""
fi

for var in DATA_INGESTION_ENDPOINT AKTO_API_KEY; do
  if [[ -z "${!var}" ]]; then
    echo "Error: $var is required."
    exit 1
  fi
done

ensure_bucket() {
  if aws s3api head-bucket --bucket "$MARKERS_BUCKET" --region "$REGION" 2>/dev/null; then
    echo "Bucket s3://$MARKERS_BUCKET exists."
    return
  fi
  echo "Creating bucket s3://$MARKERS_BUCKET ..."
  if [[ "$REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$MARKERS_BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$MARKERS_BUCKET" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION"
  fi
}

echo ""
ensure_bucket

echo "Building Lambda package..."
cd "$REPO_ROOT/lambda-function"
npm ci
VERSION=hub npm run package

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
