  #!/bin/bash
  set -e

  echo "🚀 AKTO Bedrock Admin Deployment - Multi-Region"
  BUCKET_BASE="lambda-code-akto"
  LAMBDA_ZIP="../akto-bedrock-processor.zip"
  REGIONS=("us-east-1" "us-west-2" "eu-west-1" "ap-south-1" "ap-northeast-1" "ap-southeast-1")

  echo "📦 Building Lambda package..."
  cd ../lambda-function && npm install && zip -r ../akto-bedrock-processor.zip . -x "*.git*" "node_modules/.cache/*" && cd ../cloudformation
  echo "✅ Built"

  echo "📤 Uploading to all regions..."
  for REGION in "${REGIONS[@]}"; do
    BUCKET="${BUCKET_BASE}-${REGION}"
    echo "📍 $REGION"
    aws s3 cp "$LAMBDA_ZIP" "s3://$BUCKET/akto-bedrock-processor.zip" --region "$REGION"
    echo "   ✅ Done"
  done

  echo ""
  echo "🎉 Multi-region deployment completed!"