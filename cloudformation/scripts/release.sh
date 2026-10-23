#!/bin/bash
#
# AKTO-internal release script. Never run by clients.
#
#   ./release.sh publish <version>            build the zip and upload it, with the client
#                                             template, to unified_bedrock/<version>/
#   ./release.sh promote <channel> <version>  point a channel in versions.json at a
#                                             published version and upload versions.json
#
# Every deployed stack runs an updater that reads unified_bedrock/versions.json every 15
# minutes and installs the build its channel names. So `publish` affects nobody, and
# `promote stable ...` updates EVERY client on its next check. Promote canary first.
#
# Regions default to us-east-1. Override with REGIONS="us-east-1 eu-west-1" ./release.sh ...
set -euo pipefail

PREFIX="unified_bedrock"
BUCKET_BASE="lambda-code-akto"
ZIP_NAME="akto-bedrock-processor.zip"
REGIONS="${REGIONS:-us-east-1}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$REPO_ROOT/cloudformation/templates/client-aws-cf-template.yaml"
VERSIONS_FILE="$REPO_ROOT/cloudformation/versions.json"

usage() {
  sed -n '3,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

check_version() {
  [[ "$1" =~ ^v[0-9]+\.[0-9]+$ ]] || { echo "✗ Version must look like v4.6, got '$1'"; exit 1; }
}

publish() {
  local version="$1"
  check_version "$version"

  # A published folder is permanent: clients' stacks and the updater reference it by name.
  for region in $REGIONS; do
    if aws s3api head-object --bucket "$BUCKET_BASE-$region" --key "$PREFIX/$version/$ZIP_NAME" \
        --region "$region" >/dev/null 2>&1; then
      echo "✗ $PREFIX/$version already exists in $region. Published versions are never overwritten - pick a new version."
      exit 1
    fi
  done

  echo "🧪 Running tests..."
  (cd "$REPO_ROOT/lambda-function" && node test/run-all.js)

  echo "📦 Building $version..."
  (cd "$REPO_ROOT/lambda-function" && VERSION="$version" npm run package)

  for region in $REGIONS; do
    local dest="s3://$BUCKET_BASE-$region/$PREFIX/$version"
    echo "📤 $region -> $dest/"
    aws s3 cp "$REPO_ROOT/$ZIP_NAME" "$dest/$ZIP_NAME" --region "$region"
    aws s3 cp "$TEMPLATE" "$dest/client-aws-cf-template.yaml" --region "$region"
  done

  echo ""
  echo "✅ Published $version. No client is affected until a channel is promoted:"
  echo "   ./release.sh promote canary $version"
}

promote() {
  local channel="$1" version="$2"
  check_version "$version"
  [[ "$channel" == "stable" || "$channel" == "canary" ]] || { echo "✗ Channel must be stable or canary"; exit 1; }

  # The updater would install a missing build as a failed UpdateFunctionCode every 15
  # minutes, so refuse to point a channel at something that is not there.
  for region in $REGIONS; do
    aws s3api head-object --bucket "$BUCKET_BASE-$region" --key "$PREFIX/$version/$ZIP_NAME" \
      --region "$region" >/dev/null || { echo "✗ $version is not published in $region. Run publish first."; exit 1; }
  done

  node -e '
    const fs = require("fs");
    const [file, channel, version] = process.argv.slice(1);
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    v[channel] = version;
    fs.writeFileSync(file, JSON.stringify(v, null, 2) + "\n");
  ' "$VERSIONS_FILE" "$channel" "$version"

  for region in $REGIONS; do
    aws s3 cp "$VERSIONS_FILE" "s3://$BUCKET_BASE-$region/$PREFIX/versions.json" --region "$region"
  done

  echo ""
  cat "$VERSIONS_FILE"
  echo "✅ '$channel' now points to $version. Commit cloudformation/versions.json so the repo matches S3."
}

case "${1:-}" in
  publish) [[ $# -eq 2 ]] || usage; publish "$2" ;;
  promote) [[ $# -eq 3 ]] || usage; promote "$2" "$3" ;;
  *) usage ;;
esac
