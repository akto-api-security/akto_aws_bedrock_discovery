#!/bin/bash

# CloudFormation Deployment Script for AKTO Bedrock Discovery
# Creates/updates the akto-bedrock-discovery stack from templates/client-aws-cf-template.yaml.
# Lambda code itself is NOT built/uploaded here - the template pulls a pre-published,
# versioned zip from the AKTO-managed bucket (lambda-code-akto-<region>), keyed by the
# LambdaCodeVersion parameter. See admin-deploy.sh for how that bucket gets populated.

set -e

echo "AKTO Bedrock Discovery - CloudFormation Deployment"
echo "===================================================="
echo ""

# Get AWS info
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)
REGION=${REGION:-us-east-1}

echo "AWS Information:"
echo "   Account ID: $ACCOUNT_ID"
echo "   Region: $REGION"
echo ""

# Determine environment (default to prod)
ENVIRONMENT=${1:-prod}

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(dev|staging|prod)$ ]]; then
    echo "Invalid environment. Must be: dev, staging, or prod"
    echo "Usage: ./deploy.sh [dev|staging|prod]"
    exit 1
fi

echo "Environment: $ENVIRONMENT"
echo ""

# Set parameters file and stack name based on environment
PARAMS_FILE="parameters/${ENVIRONMENT}-parameters.json"
STACK_NAME="akto-bedrock-discovery-${ENVIRONMENT}"
TEMPLATE_FILE="templates/client-aws-cf-template.yaml"

# Check if files exist
if [[ ! -f "$TEMPLATE_FILE" ]]; then
    echo "Template file not found: $TEMPLATE_FILE"
    exit 1
fi

if [[ ! -f "$PARAMS_FILE" ]]; then
    echo "Parameters file not found: $PARAMS_FILE"
    exit 1
fi

echo "Configuration:"
echo "   Stack Name: $STACK_NAME"
echo "   Template: $TEMPLATE_FILE"
echo "   Parameters: $PARAMS_FILE"
echo ""

# Ask user to review and confirm parameters
echo "Please review the parameters in $PARAMS_FILE"
echo "   Edit the file with your actual values before continuing, including LambdaCodeVersion"
echo "   (check with the AKTO team for the latest published version)."
echo ""
read -p "Have you updated the parameters file? (yes/no): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy][Ee][Ss]?$ ]]; then
    echo "Deployment cancelled. Please update parameters file and try again."
    exit 1
fi

# Step: Create or update the CloudFormation stack
STACK_EXISTS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" 2>/dev/null || echo "")

if [[ -z "$STACK_EXISTS" ]]; then
    # Create new stack
    echo "Creating CloudFormation stack: $STACK_NAME"
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

    echo "Waiting for stack creation to complete..."
    aws cloudformation wait stack-create-complete \
        --stack-name "$STACK_NAME" \
        --region "$REGION"

    echo "Stack created successfully!"
else
    # Update existing stack
    echo "Updating CloudFormation stack: $STACK_NAME"
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
        echo "No CloudFormation template changes"
    elif echo "$UPDATE_OUTPUT" | grep -q "StackId"; then
        echo "Waiting for stack update to complete..."
        aws cloudformation wait stack-update-complete \
            --stack-name "$STACK_NAME" \
            --region "$REGION" 2>/dev/null || true
        echo "Stack updated successfully!"
    else
        echo "CloudFormation update: $UPDATE_OUTPUT"
    fi
fi

echo ""
echo "Retrieving stack outputs..."
OUTPUTS=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$REGION" \
    --query 'Stacks[0].Outputs' \
    --output table)

echo "$OUTPUTS"

LAMBDA_FUNCTION_NAME="akto-bedrock-log-processor-cf-${ACCOUNT_ID}"

echo ""
echo "Deployment completed successfully!"
echo ""
echo "Next steps:"
echo "1. Confirm Bedrock Model Invocation Logging is enabled and delivering to the"
echo "   LogsBucketName/LogsPrefix you configured in $PARAMS_FILE (this stack does not"
echo "   configure Bedrock logging itself)."
echo "2. Generate some AWS Bedrock conversations."
echo "3. Monitor Lambda logs:"
echo "   aws logs tail /aws/lambda/${LAMBDA_FUNCTION_NAME} --follow --region $REGION"
echo "4. Test manually:"
echo "   aws lambda invoke --function-name ${LAMBDA_FUNCTION_NAME} --region $REGION response.json"
echo ""
echo "CloudFormation Stack Information:"
echo "   Stack Name: $STACK_NAME"
echo "   Region: $REGION"
echo "   Environment: $ENVIRONMENT"
echo ""
echo "To delete the stack:"
echo "   aws cloudformation delete-stack --stack-name $STACK_NAME --region $REGION"
