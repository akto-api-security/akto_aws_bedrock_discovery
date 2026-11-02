# Scale test: v4.5 vs v4.6 on a large log bucket

Uses your **existing** test-account deployment (running v4.5) and its Bedrock model
invocation logs bucket. All commands run in your terminal with your own AWS CLI login
for that account.

**Already done (AKTO account):** v4.6 is published at
`s3://lambda-code-akto-us-east-1/unified_bedrock/v4.6/akto-bedrock-processor.zip`. No
client is affected: clients follow the `stable` channel, which stays on v4.5.

## 0. Set up your terminal

From the repo root, logged in to the **test account**:

```bash
export AWS_REGION=us-east-1
export ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

# The deployed function names (confirm these exist)
aws lambda list-functions --query "Functions[?contains(FunctionName,'akto-bedrock')].FunctionName" --output text
export FN=akto-bedrock-log-processor-unified-$ACCOUNT
export UPD=akto-bedrock-updater-$ACCOUNT-$AWS_REGION

# Where Bedrock writes its logs: the bucket and optional key prefix
aws bedrock get-model-invocation-logging-configuration --query loggingConfig.s3Config
export BUCKET=<bucketName from above>
export KEY_PREFIX=<keyPrefix from above, or leave empty>

# Where the processor keeps its checkpoints
aws lambda get-function-configuration --function-name $FN \
  --query 'Environment.Variables.[LOGS_BUCKET_NAME,LOGS_PREFIX,MARKERS_BUCKET_NAME]' --output text
export MARKERS=<MARKERS_BUCKET_NAME from above>
```

## 1. Upload ~300,000 test log files to the logs bucket (~15–30 min, ~$1.50)

```bash
# Generate locally: no AWS calls, ~1 min, ~1.2 GB of disk
node scale-test/generate-test-bucket.js --out scale-test/bucket-data --account $ACCOUNT --key-prefix "$KEY_PREFIX"

# Upload (100 parallel uploads)
aws configure set default.s3.max_concurrent_requests 100
aws s3 sync scale-test/bucket-data s3://$BUCKET/ --only-show-errors

# Free the disk space
rm -rf scale-test/bucket-data
```

- **~297,600 files** across the last 12 months make the bucket big. v4.5 lists all of
  them; v4.6 never reads them.
- **2,400 files** across the last 24 hours (100 per hour) hold realistic conversations from
  the role `akto-scale-test-app-role`. These are what v4.6 should read and send to AKTO.
- Every test file's name contains `akto-scale-test`, so the cleanup in step 6 deletes
  only these and never Bedrock's own logs.
- Generate right before uploading: the "last 24 hours" are counted from generation time.
- The test conversations go to the AKTO instance this deployment sends to.

## 2. Prepare the processor for a controlled test

```bash
# Stop scheduled runs: you trigger runs yourself during the test
aws events disable-rule --name akto-bedrock-schedule-cf-$ACCOUNT

# 256 MB instead of 1024 MB: 300,000 files now hit the memory limit the way the
# client's millions of files do at 1024 MB
aws lambda update-function-configuration --function-name $FN --memory-size 256
aws lambda wait function-updated --function-name $FN
```

## 3. Test v4.5 (current version)

```bash
aws lambda invoke --function-name $FN --cli-binary-format raw-in-base64-out \
  --payload '{"source":"manual"}' --cli-read-timeout 0 /tmp/v45.json; cat /tmp/v45.json

aws logs tail /aws/lambda/$FN --since 20m | grep -E "started — build|Listing|REPORT|RUN SUMMARY|rror"
```

**Expected, the same failure as the client:** `build v4.5`, then
`🪣 Listing s3://…/AWSLogs/ …` and nothing after it, then `REPORT … Max Memory Used: 256 MB`
with `Status: timeout` or an out-of-memory error.

## 4. Move this deployment to v4.6

**a. You:** switch this account's updater from `stable` to `canary`. This changes only
the test account:

```bash
aws lambda get-function-configuration --function-name $UPD --query Environment > /tmp/upd-env.json
sed -i '' 's/"UPDATE_CHANNEL": "stable"/"UPDATE_CHANNEL": "canary"/' /tmp/upd-env.json
grep UPDATE_CHANNEL /tmp/upd-env.json        # must show "canary"
aws lambda update-function-configuration --function-name $UPD --environment file:///tmp/upd-env.json
```

**b. AKTO (me):** point `canary` at v4.6 with `./release.sh promote canary v4.6`. Clients stay
on `stable` = v4.5.

**c. You:** run the updater now instead of waiting up to 15 minutes, and confirm:

```bash
aws lambda invoke --function-name $UPD /tmp/upd.json; cat /tmp/upd.json
aws logs tail /aws/lambda/$UPD --since 5m | grep "Channel"
#   expect: Channel 'canary' wants v4.6 | akto-bedrock-log-processor-unified-…: v4.5 -> v4.6 …
aws lambda list-tags --resource $(aws lambda get-function --function-name $FN --query Configuration.FunctionArn --output text)
#   expect: "akto:code-version": "v4.6"
```

**d. You:** delete the checkpoints so v4.6 starts like a new deployment:

```bash
aws s3 rm s3://$MARKERS/akto/markers/ --recursive
```

Deleting the checkpoint also makes v4.6 re-read the last day of real logs, so real
conversations from the last 24 hours are sent to AKTO a second time.

## 5. Test v4.6 (same bucket, same 256 MB)

```bash
aws lambda invoke --function-name $FN --cli-binary-format raw-in-base64-out \
  --payload '{"source":"manual"}' --cli-read-timeout 0 /tmp/v46.json; cat /tmp/v46.json

aws logs tail /aws/lambda/$FN --since 10m | grep -E "started — build|No checkpoint|Reading dated|Listed|Agent Classic done|REPORT|RUN SUMMARY"
```

**Expected:**
- `build v4.6`, then `🆕 No checkpoint — reading the last 1 day(s)`
- `🪣 Reading dated log folders … by hour`
- `📊 Listed ~28 folder(s), ~2,500+ object(s)` (the last day only, plus real logs, not 300,000)
- `🎉 Bedrock Agent Classic done. Files processed: …, failed: 0, deferred: 0`
- `RUN SUMMARY … "codeVersion":"v4.6" … "stoppedBy":"work-complete"`
- `REPORT` well under 8 minutes, with `Max Memory Used` well under 256 MB
- in AKTO: agent `akto-scale-test-app-role` with ~2,400 conversations

Then run the same invoke **again**. Expect `▶️ Resuming from checkpoint`,
`Files processed: 0`, and nothing new in AKTO.

## 6. Restore and clean up

```bash
# Production memory and schedule
aws lambda update-function-configuration --function-name $FN --memory-size 1024
aws events enable-rule --name akto-bedrock-schedule-cf-$ACCOUNT

# Delete ONLY the test files
aws s3 rm s3://$BUCKET/ --recursive --exclude "*" --include "*akto-scale-test*" --only-show-errors
```

Leave the updater on `canary` for now. Switching it back to `stable` before v4.6 is
promoted to stable would move this account back to v4.5. Switch it back (the same `sed`
in reverse) once v4.6 is stable.

## Pass criteria

| | v4.5 (step 3) | v4.6 (step 5) |
|---|---|---|
| Finishes | ❌ timeout / out of memory | ✅ well under 8 min |
| Memory at 256 MB | ❌ maxed | ✅ well under |
| Objects listed | the whole bucket | the last day only |
| Checkpoint saved | ❌ | ✅ |
| Test conversations in AKTO | ❌ none | ✅ ~2,400 |
| Second run re-reads | n/a | ✅ nothing |

Send the `RUN SUMMARY` and `REPORT` lines from steps 3 and 5.
