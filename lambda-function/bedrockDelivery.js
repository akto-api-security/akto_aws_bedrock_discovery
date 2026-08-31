/**
 * Finds - or sets up - where Bedrock model invocation logs land in this account.
 *
 * Bedrock keeps ONE logging configuration per account and region. It can carry two
 * destinations at once, an S3 bucket and a CloudWatch log group, alongside a set of
 * data-delivery flags that apply to both:
 *
 *     LoggingConfig
 *       |- s3Config          { bucketName, keyPrefix }
 *       |- cloudWatchConfig  { logGroupName, roleArn }
 *       '- textDataDeliveryEnabled, imageDataDeliveryEnabled, ...
 *
 * This collector reads .gz objects out of S3 and has no CloudWatch reader for model
 * invocations, so an S3 destination is what it needs. (The separate AgentCore pipeline
 * does read CloudWatch, but those are different log groups carrying different data.)
 *
 * Four states an account can be in, and what happens in each:
 *
 *   S3 logging on          - read bucketName and keyPrefix straight off it. Bucket names
 *                            may differ per account and it just works, which is the whole
 *                            point under a StackSet where one parameter reaches every
 *                            account. Nothing is modified.
 *   CloudWatch only        - SKIPPED, in both modes. See the warning below.
 *   nothing configured     - 'create' mode makes the bucket and turns S3 logging on;
 *                            'discover' mode reports and skips.
 *   LOGS_BUCKET_NAME set   - short-circuits all of the above. An explicit name always
 *                            wins, which is what keeps single-stack behaviour unchanged.
 *
 * WHY CLOUDWATCH-ONLY IS NEVER TOUCHED
 *
 * PutModelInvocationLoggingConfiguration replaces the entire configuration - there is no
 * call that adds a destination. Writing an s3Config into an account that logs to
 * CloudWatch would therefore delete cloudWatchConfig and silently switch their logging
 * off, taking any dashboards and alarms with it. Reading first and merging would work,
 * but the data-delivery flags are shared between both destinations, so getting our
 * payload sizes right would mean changing what their CloudWatch logs contain. Neither is
 * ours to do, so those accounts are reported and left alone.
 *
 * Every operation here is idempotent, which is what lets one StackSet parameter set cover
 * a fleet where some accounts already log and some do not.
 */
const {
    GetModelInvocationLoggingConfigurationCommand,
    PutModelInvocationLoggingConfigurationCommand
} = require('@aws-sdk/client-bedrock');
const { CreateBucketCommand, PutBucketPolicyCommand, GetBucketPolicyCommand } = require('@aws-sdk/client-s3');

const {
    AWS_REGION, AWS_ACCOUNT_ID, LOGS_BUCKET_NAME, LOGS_PREFIX,
    BEDROCK_LOGGING_MODE, BEDROCK_CREATED_BUCKET_NAME,
    bedrockClient, s3Client
} = require('./config');

/**
 * Bedrock's own portion of the S3 key, beneath whatever keyPrefix the configuration sets:
 *
 *   [keyPrefix/]AWSLogs/<account>/BedrockModelInvocationLogs/<region>/<yyyy>/<MM>/<dd>/<HH>/...
 *
 * Only the leading 'AWSLogs/' is used as the listing prefix rather than the full path.
 * The deeper segments are an AWS naming convention rather than a documented contract, and
 * listing too narrowly would silently return nothing if AWS ever changed them.
 */
function listingPrefix(keyPrefix) {
    const base = String(keyPrefix || '').replace(/^\/+|\/+$/g, '');
    return base ? `${base}/AWSLogs/` : 'AWSLogs/';
}

/** The current configuration, or null when the account has none at all. */
async function getLoggingConfig() {
    try {
        const response = await bedrockClient.send(new GetModelInvocationLoggingConfigurationCommand({}));
        return response?.loggingConfig || null;
    } catch (error) {
        /*
         * An account that never enabled logging answers ResourceNotFound rather than
         * returning an empty configuration. That is a normal state to be in, not a
         * failure, so it is reported as "nothing configured" and create mode proceeds.
         */
        if (error?.name === 'ResourceNotFoundException') return null;
        throw error;
    }
}

/**
 * Creates the bucket if absent and authorises Bedrock to write into it.
 *
 * Returns the bucket name. Safe to call against a bucket that already exists: the policy
 * merge below is the part that actually matters, and an administrator who pre-created the
 * bucket will not have added it.
 */
async function ensureBucket(bucket) {
    try {
        await s3Client.send(new CreateBucketCommand({
            Bucket: bucket,
            // us-east-1 rejects an explicit LocationConstraint; every other region requires it.
            ...(AWS_REGION === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: AWS_REGION } })
        }));
        console.log(`🪣 Created Bedrock logs bucket ${bucket}`);
    } catch (error) {
        const name = error?.name || '';
        if (name === 'BucketAlreadyOwnedByYou') {
            console.log(`🪣 Bedrock logs bucket ${bucket} already exists — reusing it`);
        } else if (name === 'BucketAlreadyExists') {
            // Global namespace collision with a bucket in someone else's account.
            throw new Error(`Bucket name '${bucket}' is taken by another AWS account — choose a different BEDROCK_BUCKET_BASE_NAME`);
        } else {
            throw error;
        }
    }

    /*
     * Deliberately WITHOUT the `s3:x-amz-acl: bucket-owner-full-control` condition that
     * AWS's published policy for this carries.
     *
     * That condition dates from when buckets had ACLs enabled. Buckets created since
     * April 2023 default to ObjectOwnership=BucketOwnerEnforced, which REJECTS a PutObject
     * carrying an ACL — so requiring the ACL means the statement can never match, the
     * write is denied by default, and logs silently never appear. That failure looks
     * exactly like "this account has no Bedrock traffic", which is the worst way to fail.
     *
     * Dropping it costs nothing: SourceAccount and SourceArn already restrict this to
     * Bedrock acting for THIS account in THIS region, and the bucket and the traffic are
     * in the same account, so there is no cross-account ownership problem to solve.
     */
    const statement = {
        Sid: 'AktoAllowBedrockModelInvocationLogs',
        Effect: 'Allow',
        Principal: { Service: 'bedrock.amazonaws.com' },
        Action: 's3:PutObject',
        Resource: `arn:aws:s3:::${bucket}/AWSLogs/${AWS_ACCOUNT_ID}/*`,
        Condition: {
            StringEquals: { 'aws:SourceAccount': AWS_ACCOUNT_ID },
            ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:*` }
        }
    };

    // Merge rather than overwrite: the bucket may already carry policy this function knows
    // nothing about, and clobbering it could break another log source entirely.
    let policy = { Version: '2012-10-17', Statement: [] };
    try {
        const existing = await s3Client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
        const parsed = JSON.parse(existing.Policy);
        if (Array.isArray(parsed?.Statement)) policy = parsed;
    } catch (error) {
        // NoSuchBucketPolicy simply means there is nothing to merge with.
        if (error?.name !== 'NoSuchBucketPolicy') throw error;
    }

    policy.Statement = policy.Statement.filter((s) => s?.Sid !== statement.Sid);
    policy.Statement.push(statement);
    await s3Client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
    console.log(`🔐 Authorised bedrock.amazonaws.com to write logs into ${bucket}`);
    return bucket;
}

/**
 * Turns S3 model invocation logging on.
 *
 * Only ever called against an EMPTY configuration, so the whole object is ours to define
 * and nothing existing is displaced.
 *
 * Text only, on purpose. The flags apply to every destination and control what Bedrock
 * writes into each log record; images, video, audio and embedding vectors contribute
 * nothing to conversation extraction while inflating every payload — and payload size is
 * the constraint this pipeline runs into first, at the ingest API and again at the broker.
 */
async function enableS3Logging(bucket) {
    const put = () => bedrockClient.send(new PutModelInvocationLoggingConfigurationCommand({
        loggingConfig: {
            s3Config: { bucketName: bucket, keyPrefix: '' },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
            videoDataDeliveryEnabled: false
        }
    }));

    /*
     * Bedrock validates at this call that it can actually write to the bucket, and a
     * policy put moments ago may not have propagated yet. That races on a first run and
     * then succeeds seconds later, so one retry turns a hard failure into a short pause.
     */
    try {
        await put();
    } catch (error) {
        if (!/ValidationException|AccessDenied/i.test(error?.name || '')) throw error;
        console.log('⏳ Bucket policy not visible to Bedrock yet — retrying in 5s');
        await new Promise((resolve) => setTimeout(resolve, 5000));
        await put();
    }
    console.log(`✅ Enabled Bedrock model invocation logging to ${bucket} (text only)`);
}

/**
 * Where this account's model invocation logs are, or why there are none.
 *
 * Returns either { bucket, prefix } for the S3 pipeline to read, or { skip: true, reason }
 * when this account has nothing to offer. Skipping is a normal outcome across a fleet, not
 * an error: the caller reports it and carries on with the AgentCore pipeline, which reads
 * CloudWatch and is unaffected by any of this.
 */
async function resolveBedrockLogLocation() {
    // An explicit bucket always wins. This is the single-stack path, unchanged.
    if (LOGS_BUCKET_NAME && String(LOGS_BUCKET_NAME).trim()) {
        return { bucket: LOGS_BUCKET_NAME.trim(), prefix: LOGS_PREFIX };
    }

    const config = await getLoggingConfig();

    if (config?.s3Config?.bucketName) {
        const bucket = config.s3Config.bucketName;
        const prefix = listingPrefix(config.s3Config.keyPrefix);
        console.log(`📍 Bedrock logs discovered at s3://${bucket}/${prefix}`);
        return { bucket, prefix };
    }

    if (config?.cloudWatchConfig?.logGroupName) {
        return {
            skip: true,
            reason: `model invocation logging writes only to CloudWatch (${config.cloudWatchConfig.logGroupName}); `
                + 'an S3 destination is required and this account\'s configuration is deliberately left untouched'
        };
    }

    if (BEDROCK_LOGGING_MODE !== 'create') {
        return {
            skip: true,
            reason: 'model invocation logging is not enabled; set BEDROCK_LOGGING_MODE=create to enable it automatically'
        };
    }

    console.log(`⚙️ No model invocation logging configured — enabling it (${BEDROCK_CREATED_BUCKET_NAME})`);
    await ensureBucket(BEDROCK_CREATED_BUCKET_NAME);
    await enableS3Logging(BEDROCK_CREATED_BUCKET_NAME);

    /*
     * Bedrock has only just started writing, so this run finds nothing. That is expected
     * and not worth flagging as a problem: the next scheduled run picks up whatever was
     * logged in between.
     */
    return { bucket: BEDROCK_CREATED_BUCKET_NAME, prefix: 'AWSLogs/', justCreated: true };
}

module.exports = { resolveBedrockLogLocation, listingPrefix };
