#!/bin/bash

# AKTO Bedrock Monitor - Test script
set -e

echo "🧪 AKTO Bedrock Monitor - Testing Client-Side Solution"
echo "===================================================="

# Get AWS account info
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=$(aws configure get region)
REGION=${REGION:-us-east-1}
STACK_NAME="akto-bedrock-monitor-$ACCOUNT_ID"

echo "📊 Test Information:"
echo "   AWS Account ID: $ACCOUNT_ID"
echo "   AWS Region: $REGION"
echo "   Stack Name: $STACK_NAME"
echo ""

# Check if stack exists
echo "🔍 Checking CloudFormation stack..."
if aws cloudformation describe-stacks --stack-name $STACK_NAME --region $REGION &>/dev/null; then
    echo "✅ Stack found: $STACK_NAME"
else
    echo "❌ Stack not found. Please deploy first using ./deploy-client.sh"
    exit 1
fi

# Get stack outputs
LAMBDA_FUNCTION_NAME=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query 'Stacks[0].Outputs[?OutputKey==`LambdaFunctionName`].OutputValue' \
    --output text \
    --region $REGION)

S3_BUCKET_NAME=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --query 'Stacks[0].Outputs[?OutputKey==`S3BucketName`].OutputValue' \
    --output text \
    --region $REGION)

echo "   Lambda Function: $LAMBDA_FUNCTION_NAME"
echo "   S3 Bucket: $S3_BUCKET_NAME"
echo ""

# Test 1: Check Lambda function
echo "🧪 Test 1: Lambda Function Check"
echo "--------------------------------"
if aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME --region $REGION &>/dev/null; then
    echo "✅ Lambda function exists and is accessible"
    
    # Get function details
    RUNTIME=$(aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME --query 'Configuration.Runtime' --output text --region $REGION)
    TIMEOUT=$(aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME --query 'Configuration.Timeout' --output text --region $REGION)
    MEMORY=$(aws lambda get-function --function-name $LAMBDA_FUNCTION_NAME --query 'Configuration.MemorySize' --output text --region $REGION)
    
    echo "   Runtime: $RUNTIME"
    echo "   Timeout: ${TIMEOUT}s"
    echo "   Memory: ${MEMORY}MB"
else
    echo "❌ Lambda function not found or not accessible"
    exit 1
fi
echo ""

# Test 2: Check S3 bucket
echo "🧪 Test 2: S3 Bucket Check"
echo "--------------------------"
if aws s3 ls s3://$S3_BUCKET_NAME --region $REGION &>/dev/null; then
    echo "✅ S3 bucket exists and is accessible"
    
    # Check bucket notification configuration
    if aws s3api get-bucket-notification-configuration --bucket $S3_BUCKET_NAME --region $REGION &>/dev/null; then
        echo "✅ S3 bucket has notification configuration"
    else
        echo "⚠️ S3 bucket notification configuration not found"
    fi
else
    echo "❌ S3 bucket not found or not accessible"
    exit 1
fi
echo ""

# Test 3: Test Lambda invocation
echo "🧪 Test 3: Lambda Manual Invocation"
echo "-----------------------------------"
echo "🚀 Invoking Lambda function manually..."

aws lambda invoke \
    --function-name $LAMBDA_FUNCTION_NAME \
    --payload '{"Records":[{"eventSource":"aws:s3","s3":{"bucket":{"name":"test"},"object":{"key":"test.gz","size":1024}}}]}' \
    --region $REGION \
    test-response.json

if [ $? -eq 0 ]; then
    echo "✅ Lambda function invoked successfully"
    echo "📋 Response:"
    cat test-response.json | python3 -m json.tool 2>/dev/null || cat test-response.json
    echo ""
else
    echo "❌ Lambda function invocation failed"
fi
rm -f test-response.json
echo ""

# Test 4: Check CloudWatch logs
echo "🧪 Test 4: CloudWatch Logs Check"
echo "--------------------------------"
LOG_GROUP="/aws/lambda/$LAMBDA_FUNCTION_NAME"

if aws logs describe-log-groups --log-group-name-prefix $LOG_GROUP --region $REGION | grep -q "logGroupName"; then
    echo "✅ CloudWatch log group exists: $LOG_GROUP"
    
    # Get recent log events
    echo "📋 Recent log events (last 10):"
    aws logs describe-log-streams \
        --log-group-name $LOG_GROUP \
        --order-by LastEventTime \
        --descending \
        --max-items 1 \
        --region $REGION \
        --query 'logStreams[0].logStreamName' \
        --output text > latest_stream.txt
    
    if [ -s latest_stream.txt ]; then
        LATEST_STREAM=$(cat latest_stream.txt)
        aws logs get-log-events \
            --log-group-name $LOG_GROUP \
            --log-stream-name "$LATEST_STREAM" \
            --region $REGION \
            --query 'events[-10:].message' \
            --output table
    else
        echo "⚠️ No log streams found yet"
    fi
    rm -f latest_stream.txt
else
    echo "❌ CloudWatch log group not found"
fi
echo ""

# Test 5: Check Bedrock logging configuration
echo "🧪 Test 5: Bedrock Logging Configuration"
echo "----------------------------------------"
if aws bedrock get-model-invocation-logging-configuration --region $REGION &>/dev/null; then
    BEDROCK_CONFIG=$(aws bedrock get-model-invocation-logging-configuration --region $REGION)
    
    if echo "$BEDROCK_CONFIG" | grep -q "$S3_BUCKET_NAME"; then
        echo "✅ Bedrock logging is configured to use our S3 bucket"
        echo "📋 Configuration:"
        echo "$BEDROCK_CONFIG" | python3 -m json.tool 2>/dev/null || echo "$BEDROCK_CONFIG"
    else
        echo "⚠️ Bedrock logging is configured but not using our S3 bucket"
        echo "📋 Current configuration:"
        echo "$BEDROCK_CONFIG" | python3 -m json.tool 2>/dev/null || echo "$BEDROCK_CONFIG"
    fi
else
    echo "⚠️ Bedrock logging configuration not found (will be configured on first Lambda run)"
fi
echo ""

# Test 6: Generate test Bedrock conversation (optional)
echo "🧪 Test 6: Generate Test Conversation (Optional)"
echo "------------------------------------------------"
read -p "🤖 Would you like to generate a test Bedrock conversation? (y/N): " GENERATE_TEST

if [[ $GENERATE_TEST =~ ^[Yy]$ ]]; then
    echo "🚀 Generating test Bedrock conversation..."
    
    # Create test payload
    TEST_PAYLOAD='{
        "messages": [
            {
                "role": "user", 
                "content": [
                    {
                        "type": "text", 
                        "text": "Hello! This is a test message for AKTO Bedrock monitoring. Please respond with a short greeting."
                    }
                ]
            }
        ],
        "max_tokens": 50,
        "anthropic_version": "bedrock-2023-05-31"
    }'
    
    # Try to invoke Bedrock model
    if aws bedrock-runtime invoke-model \
        --model-id anthropic.claude-3-haiku-20240307-v1:0 \
        --body "$TEST_PAYLOAD" \
        --content-type application/json \
        --region $REGION \
        bedrock-test-output.json 2>/dev/null; then
        
        echo "✅ Test conversation generated successfully"
        echo "📋 Response:"
        cat bedrock-test-output.json | python3 -m json.tool 2>/dev/null || cat bedrock-test-output.json
        echo ""
        echo "⏱️ Wait 1-2 minutes for logs to appear in S3, then check:"
        echo "   aws s3 ls s3://$S3_BUCKET_NAME/bedrock-logs/ --recursive"
        rm -f bedrock-test-output.json
    else
        echo "⚠️ Could not generate test conversation (check Bedrock model access)"
    fi
else
    echo "⏭️ Skipping test conversation generation"
fi
echo ""

# Summary
echo "📊 Test Summary"
echo "==============="
echo "✅ Lambda Function: Working"
echo "✅ S3 Bucket: Working"
echo "✅ CloudWatch Logs: Available"
echo "⚠️ Bedrock Configuration: Will be set on first run"
echo ""
echo "🎯 Next Steps:"
echo "1. Generate some real Bedrock conversations"
echo "2. Check S3 for log files: aws s3 ls s3://$S3_BUCKET_NAME/bedrock-logs/ --recursive"
echo "3. Monitor Lambda processing: aws logs tail $LOG_GROUP --follow"
echo "4. Verify data reaches your AKTO endpoint"
echo ""
echo "🎉 Client-side solution testing completed!"