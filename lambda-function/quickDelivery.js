/**
 * Finds — or sets up — where Amazon Quick Suite writes its chat logs.
 *
 * Quick does not log to S3 by default. A CloudWatch Logs "vended log delivery" has to
 * exist, made of three linked resources:
 *
 *     DeliverySource (CHAT_LOGS on the Quick account)
 *         -> Delivery
 *             -> DeliveryDestination (an S3 bucket)
 *
 * This module covers both states an account can be in:
 *
 *   discover - a delivery already exists. Read the bucket and path straight off it, so
 *              the operator never has to know or type a bucket name. Different accounts
 *              can use completely different bucket names and it just works.
 *   create   - no delivery exists. Make the bucket, authorise the log-delivery service
 *              to write to it, and create the three resources — asking for every record
 *              field including the five AWS omits unless explicitly requested.
 *
 * Everything here is S3-only. An account can have a second delivery pointing at
 * CloudWatch Logs from the same source (a common setup); that one is deliberately
 * ignored, because this collector reads objects from S3 and nothing else.
 *
 * Every operation is idempotent, which is what lets one StackSet parameter set cover a
 * fleet where some accounts already log and some don't.
 */
const {
    DescribeDeliverySourcesCommand, DescribeDeliveriesCommand, GetDeliveryCommand,
    GetDeliveryDestinationCommand, PutDeliverySourceCommand, PutDeliveryDestinationCommand,
    CreateDeliveryCommand
} = require('@aws-sdk/client-cloudwatch-logs');
const { CreateBucketCommand, PutBucketPolicyCommand, GetBucketPolicyCommand } = require('@aws-sdk/client-s3');
const { ListAgentsCommand } = require('@aws-sdk/client-quicksight');
const {
    AWS_REGION, AWS_ACCOUNT_ID, QUICK_LOGGING_MODE, QUICK_CREATED_BUCKET_NAME,
    QUICK_DELIVERY_SOURCE_NAME, QUICK_DELIVERY_DESTINATION_NAME, QUICK_RECORD_FIELDS,
    cloudWatchLogsClient, s3Client, quickSightClient
} = require('./config');

/** The Quick Suite account resource this region's delivery source points at. */
function quickAccountArn() {
    return `arn:aws:quicksight:${AWS_REGION}:${AWS_ACCOUNT_ID}:account/${AWS_ACCOUNT_ID}`;
}

/** Pages through a Describe* call that uses CloudWatch Logs' lowercase nextToken. */
async function listAll(send, pluck) {
    let items = [];
    let nextToken;
    do {
        const response = await send(nextToken);
        items = items.concat(pluck(response) || []);
        nextToken = response.nextToken;
    } while (nextToken);
    return items;
}

/**
 * The AWS-fixed portion of the S3 key that Quick's vended logs land under, ahead of the
 * delivery's own suffixPath. Observed shape:
 *
 *   AWSLogs/<account>/quicksuitelogs/<region>/<yyyy>/<MM>/<dd>/<HH>/<file>.log.gz
 *
 * Used as the listing prefix so a bucket shared with other vended logs is not scanned in
 * full. Callers fall back to the broader 'AWSLogs/' if this yields nothing, since the
 * middle segment is an AWS naming convention rather than a documented contract.
 */
function derivePrefix() {
    return `AWSLogs/${AWS_ACCOUNT_ID}/quicksuitelogs/`;
}

/** Finds the CHAT_LOGS delivery source for this region's Quick account, or null. */
async function findChatLogsSource() {
    const sources = await listAll(
        (nextToken) => cloudWatchLogsClient.send(new DescribeDeliverySourcesCommand({ nextToken })),
        (response) => response.deliverySources
    );
    const wanted = quickAccountArn().toLowerCase();
    return sources.find((source) =>
        String(source?.logType).toUpperCase() === 'CHAT_LOGS'
        && (source.resourceArns || []).some((arn) => String(arn).toLowerCase() === wanted)
    ) || null;
}

/**
 * Resolves the S3 bucket and listing prefix from an existing delivery.
 *
 * Three outcomes, because they need three different fixes:
 *   null                        - no CHAT_LOGS source at all; logging was never set up
 *   { needsS3Delivery: true }   - a source exists but nothing delivers to S3 (typically
 *                                 CloudWatch Logs only). The source is reusable: adding
 *                                 an S3 delivery to it is the fix, not a new source.
 *   { bucket, prefix, ... }     - an S3 delivery exists; read straight from it.
 */
async function discoverDelivery() {
    let source;
    try {
        source = await findChatLogsSource();
    } catch (error) {
        console.error(`❌ Could not list Quick log deliveries (check logs:DescribeDeliverySources): ${error.message}`);
        return null;
    }
    if (!source) return null;

    const deliveries = await listAll(
        (nextToken) => cloudWatchLogsClient.send(new DescribeDeliveriesCommand({ nextToken })),
        (response) => response.deliveries
    );
    const mine = deliveries.filter((d) => d?.deliverySourceName === source.name);
    const s3Delivery = mine.find((d) => String(d.deliveryDestinationType).toUpperCase() === 'S3');

    if (!s3Delivery) {
        /*
         * A source exists but nothing delivers to S3 — usually because logging was set
         * up to CloudWatch Logs only.
         *
         * These are NOT alternatives: one delivery source can feed several deliveries at
         * once, and a CWL delivery and an S3 delivery happily coexist on the same source.
         * So the fix is to ADD an S3 delivery to this source, never to make a second
         * source — two sources for the same Quick account would deliver the same chat
         * logs twice and make discovery ambiguous.
         */
        return {
            needsS3Delivery: true,
            sourceName: source.name,
            destinationTypes: [...new Set(mine.map((d) => d.deliveryDestinationType))]
        };
    }

    // GetDelivery carries suffixPath and recordFields, which DescribeDeliveries omits.
    const detail = (await cloudWatchLogsClient.send(new GetDeliveryCommand({ id: s3Delivery.id }))).delivery || {};
    const destinationName = String(detail.deliveryDestinationArn || s3Delivery.deliveryDestinationArn || '').split(':delivery-destination:').pop();
    const destination = (await cloudWatchLogsClient.send(new GetDeliveryDestinationCommand({ name: destinationName }))).deliveryDestination || {};
    const bucketArn = destination.deliveryDestinationConfiguration?.destinationResourceArn || '';
    const bucket = bucketArn.replace(/^arn:aws[a-z-]*:s3:::/, '');

    if (!bucket) {
        console.warn(`⚠️ Quick delivery ${s3Delivery.id} resolved to no S3 bucket (destination '${destinationName}') — cannot read logs`);
        return null;
    }

    const recordFields = detail.recordFields || [];
    // The five opt-in fields are all-or-nothing per delivery, so one is enough to test.
    const hasOptionalFields = recordFields.includes('latency');

    return {
        bucket,
        prefix: derivePrefix(),
        suffixPath: detail.s3DeliveryConfiguration?.suffixPath || '',
        deliveryId: s3Delivery.id,
        sourceName: source.name,
        recordFields,
        hasOptionalFields,
        needsS3Delivery: false
    };
}

/**
 * Is Quick Suite actually present in THIS region for this account?
 *
 * Returns false both when the account simply isn't homed here (ListAgents answers with an
 * empty list) and when the region doesn't implement the Agents API at all (a 404 that the
 * SDK surfaces as an error). Both mean the same thing for our purposes: do not provision.
 *
 * Errs on the side of NOT creating: an unexpected failure here returns false, so a
 * transient API problem costs a delayed setup rather than a stray bucket.
 */
async function quickExistsHere() {
    try {
        // Reuse the configured client rather than building one here: same credentials,
        // same retry behaviour, and one place that decides the region.
        const response = await quickSightClient.send(new ListAgentsCommand({ AwsAccountId: AWS_ACCOUNT_ID }));
        return (response.AgentSummaries || []).length > 0;
    } catch (error) {
        console.warn(`⚠️ Could not confirm Quick Suite is present in ${AWS_REGION} (${error.message}) — not provisioning here`);
        return false;
    }
}

/**
 * Creates the bucket the delivery will write to, if it isn't there already.
 *
 * Vended log delivery will not write to a bucket it has no permission on, so the bucket
 * policy granting delivery.logs.amazonaws.com matters as much as the bucket. Both calls
 * tolerate the resource already existing, so this is safe to run every invocation.
 */
async function ensureBucket(bucket) {
    try {
        await s3Client.send(new CreateBucketCommand({
            Bucket: bucket,
            // us-east-1 rejects an explicit LocationConstraint; every other region requires it.
            ...(AWS_REGION === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: AWS_REGION } })
        }));
        console.log(`🪣 Created Quick logs bucket ${bucket}`);
    } catch (error) {
        const name = error?.name || '';
        if (name === 'BucketAlreadyOwnedByYou') {
            // Normal when an administrator pre-created the bucket. The policy merge below
            // is the part that actually matters — without it the delivery service cannot
            // write and no logs ever arrive.
            console.log(`🪣 Quick logs bucket ${bucket} already exists — reusing it`);
        } else if (name === 'BucketAlreadyExists') {
            // Global namespace collision with a bucket in someone else's account.
            throw new Error(`Bucket name '${bucket}' is taken by another AWS account — choose a different QUICK_BUCKET_BASE_NAME`);
        } else {
            throw error;
        }
    }

    /*
     * Deliberately WITHOUT the `s3:x-amz-acl: bucket-owner-full-control` condition that
     * AWS's published vended-logs policy carries.
     *
     * That condition dates from when buckets had ACLs enabled. Buckets created since
     * April 2023 default to ObjectOwnership=BucketOwnerEnforced, which REJECTS a
     * PutObject that carries an ACL — so requiring the ACL means the statement can never
     * match, the write is denied by default, and logs silently never appear. The failure
     * looks exactly like "this account has no traffic", which is the worst way to fail.
     *
     * Dropping it costs nothing here: SourceAccount and SourceArn already restrict this
     * to the log-delivery service acting for THIS account, from a delivery source in this
     * account and region. The bucket and the log source are the same account, so there is
     * no cross-account ownership problem for the ACL to solve.
     */
    const statement = {
        Sid: 'AWSLogDeliveryWriteQuickSuite',
        Effect: 'Allow',
        Principal: { Service: 'delivery.logs.amazonaws.com' },
        Action: 's3:PutObject',
        Resource: `arn:aws:s3:::${bucket}/AWSLogs/${AWS_ACCOUNT_ID}/*`,
        Condition: {
            StringEquals: { 'aws:SourceAccount': AWS_ACCOUNT_ID },
            ArnLike: { 'aws:SourceArn': `arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:delivery-source:*` }
        }
    };

    // Merge rather than overwrite: the bucket may already carry policy this function
    // knows nothing about, and clobbering it could break another log source entirely.
    let policy = { Version: '2012-10-17', Statement: [] };
    try {
        const existing = await s3Client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
        policy = JSON.parse(existing.Policy);
        if (!Array.isArray(policy.Statement)) policy.Statement = [];
    } catch (error) {
        if (error?.name !== 'NoSuchBucketPolicy') {
            console.warn(`⚠️ Could not read existing bucket policy on ${bucket} (${error.message}) — writing a fresh one`);
        }
    }
    if (policy.Statement.some((s) => s?.Sid === statement.Sid)) return;

    policy.Statement.push(statement);
    await s3Client.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
    console.log(`🔐 Granted delivery.logs.amazonaws.com write access on ${bucket}`);
}

/**
 * Creates the CHAT_LOGS delivery chain. Safe to call when parts already exist:
 * PutDeliverySource and PutDeliveryDestination are upserts, and a duplicate
 * CreateDelivery is treated as success rather than an error.
 */
async function createDelivery(bucket, existingSourceName) {
    // Reuse the account's existing CHAT_LOGS source when there is one. Creating another
    // for the same Quick account would duplicate every chat log and leave discovery
    // picking arbitrarily between two sources.
    const sourceName = existingSourceName || QUICK_DELIVERY_SOURCE_NAME;
    if (existingSourceName) {
        console.log(`♻️ Reusing existing delivery source '${existingSourceName}' and adding an S3 delivery to it`);
    } else {
        await cloudWatchLogsClient.send(new PutDeliverySourceCommand({
            name: sourceName,
            logType: 'CHAT_LOGS',
            resourceArn: quickAccountArn()
        }));
    }

    const destination = await cloudWatchLogsClient.send(new PutDeliveryDestinationCommand({
        name: QUICK_DELIVERY_DESTINATION_NAME,
        outputFormat: 'json',
        deliveryDestinationConfiguration: { destinationResourceArn: `arn:aws:s3:::${bucket}` }
    }));

    const destinationArn = destination.deliveryDestination?.arn;
    try {
        await cloudWatchLogsClient.send(new CreateDeliveryCommand({
            deliverySourceName: sourceName,
            deliveryDestinationArn: destinationArn,
            recordFields: QUICK_RECORD_FIELDS
        }));
        console.log(`✅ Enabled Quick chat logging → s3://${bucket} (${QUICK_RECORD_FIELDS.length} record fields, including latency and time_to_first_token)`);
    } catch (error) {
        if (error?.name === 'ConflictException' || /already exists/i.test(error?.message || '')) {
            console.log('ℹ️ Quick chat delivery already existed — left as it is');
            return;
        }
        throw error;
    }
}

/**
 * Single entry point: returns {bucket, prefix, ...} describing where to read Quick chat
 * logs in this account and region, or null if there is nothing to read.
 *
 * Discovery runs first in BOTH modes. That is what makes 'create' safe to point at a
 * mixed fleet: an account that already logs is detected and left untouched rather than
 * given a second, duplicate delivery.
 */
async function resolveQuickLogLocation() {
    const existing = await discoverDelivery();

    if (existing && !existing.needsS3Delivery) {
        console.log(`🔎 Found existing Quick CHAT_LOGS delivery '${existing.sourceName}' → s3://${existing.bucket}/${existing.prefix}`);
        if (!existing.hasOptionalFields) {
            console.warn('⚠️ This delivery does not request namespace/latency/time_to_first_token/surface_type/web_search. AWS omits them unless CreateDelivery asks, and they cannot be added to an existing delivery — recreate it to capture latency data.');
        }
        return existing;
    }

    if (existing?.needsS3Delivery) {
        const targets = existing.destinationTypes.length ? existing.destinationTypes.join('/') : 'nothing';
        console.warn(`⚠️ Quick delivery source '${existing.sourceName}' exists but delivers to ${targets}, not S3. This collector reads S3 only.`);
        if (QUICK_LOGGING_MODE !== 'create') {
            console.warn(`   Fix: add an S3 delivery to the SAME source (a source can feed CWL and S3 at once), or set QUICK_LOGGING_MODE=create to have one added automatically.`);
            return null;
        }
    }

    if (QUICK_LOGGING_MODE !== 'create') {
        console.warn(`⚠️ No Quick CHAT_LOGS delivery to S3 in ${AWS_REGION} for account ${AWS_ACCOUNT_ID}. Either Quick logging was never enabled here, or Quick is homed in another region. Set QUICK_LOGGING_MODE=create to enable it automatically.`);
        return null;
    }

    if (!QUICK_CREATED_BUCKET_NAME) {
        console.error('❌ QUICK_LOGGING_MODE=create but QUICK_BUCKET_BASE_NAME is unset — nothing to name the bucket');
        return null;
    }

    /*
     * Never provision in a region that has no Quick Suite.
     *
     * A StackSet targeting several regions puts a Lambda in every one of them, but an
     * account's Quick subscription lives in only some. Without this check, 'create' mode
     * in a Quick-less region would still call CreateBucket — which SUCCEEDS — leaving an
     * empty bucket behind in every such account and region, and then fail on
     * PutDeliverySource and retry the whole thing every 10 minutes forever. At 100
     * accounts across 4 regions that is 300 orphan buckets, and S3 allows only 100 per
     * account by default, so it can start breaking unrelated bucket creation.
     *
     * ListAgents is the cheapest reliable probe: it returns 0 where the account is not
     * homed and throws 404 where the API isn't implemented at all, and the pipeline is
     * about to call it anyway.
     */
    if (!(await quickExistsHere())) {
        console.log(`⏭️ No Quick Suite in ${AWS_REGION} for account ${AWS_ACCOUNT_ID} — nothing created, nothing to read`);
        return null;
    }

    const reuseSource = existing?.needsS3Delivery ? existing.sourceName : null;
    console.log(reuseSource
        ? `🛠️ Adding an S3 delivery to existing source '${reuseSource}' (bucket ${QUICK_CREATED_BUCKET_NAME})`
        : `🛠️ No Quick chat logging in ${AWS_REGION} — creating it (bucket ${QUICK_CREATED_BUCKET_NAME})`);
    try {
        await ensureBucket(QUICK_CREATED_BUCKET_NAME);
        await createDelivery(QUICK_CREATED_BUCKET_NAME, reuseSource);
    } catch (error) {
        console.error(`❌ Could not enable Quick chat logging: ${error.message}`);
        return null;
    }

    // Nothing to read yet: AWS batches vended logs roughly every five minutes, so the
    // first objects appear on a later invocation.
    return {
        bucket: QUICK_CREATED_BUCKET_NAME,
        prefix: derivePrefix(),
        justCreated: true,
        hasOptionalFields: true,
        needsS3Delivery: false
    };
}

module.exports = {
    resolveQuickLogLocation, discoverDelivery, ensureBucket, createDelivery, quickExistsHere,
    quickAccountArn, derivePrefix, findChatLogsSource
};
