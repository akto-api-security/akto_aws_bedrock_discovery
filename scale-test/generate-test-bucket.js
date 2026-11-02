#!/usr/bin/env node
/**
 * Builds a test bucket that looks like a busy client's Bedrock log bucket, to reproduce
 * the v4.5 listing failure and verify the v4.6 fix (see scale-test/README.md).
 *
 * Layout matches what Bedrock writes:
 *   AWSLogs/<account>/BedrockModelInvocationLogs/<region>/YYYY/MM/DD/HH/<stamp>_<id>.json.gz
 *
 *   - Months of history, spread evenly across every hour folder: these make the bucket
 *     large. v4.5 lists all of them; v4.6 must never touch them.
 *   - The last 24 hours, denser and with realistic log entries: what v4.6 should read
 *     and send to AKTO.
 *
 * S3 sets LastModified to the upload time, so every object looks "new" to v4.5's
 * filter — it would try to read all of them even if listing them didn't exhaust
 * memory first. v4.6 decides what to read by folder, so it reads only the last day.
 *
 * Usage — write the files to a local folder, then upload them yourself with the AWS CLI
 * (no AWS access needed to generate):
 *   node scale-test/generate-test-bucket.js --out scale-test/bucket-data [--account <id>] [--region us-east-1]
 *   aws s3 sync scale-test/bucket-data s3://<bucket>/ --only-show-errors
 *
 * Or upload directly from the script, using the same credentials as your AWS CLI:
 *   node scale-test/generate-test-bucket.js --bucket <name> [--region us-east-1]
 *        [--files 300000] [--months 12] [--recent-per-hour 100] [--concurrency 200] [--account <id>]
 *   node scale-test/generate-test-bucket.js --bucket <name> --dry-run    # show the plan, upload nothing
 *   node scale-test/generate-test-bucket.js --bucket <name> --delete     # empty and remove it
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createRequire } = require('module');

// The Lambda's own dependencies — no separate install for this script.
const requireLambda = createRequire(path.join(__dirname, '..', 'lambda-function', 'package.json'));
const {
    S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand,
    ListObjectsV2Command, DeleteObjectsCommand, DeleteBucketCommand
} = requireLambda('@aws-sdk/client-s3');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
    const args = { region: 'us-east-1', files: 300000, months: 12, recentPerHour: 100, concurrency: 200, delete: false, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i].replace(/^--/, '');
        if (key === 'delete') { args.delete = true; continue; }
        if (key === 'dry-run') { args.dryRun = true; continue; }
        const camel = key.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        const value = argv[++i];
        args[camel] = ['files', 'months', 'recentPerHour', 'concurrency'].includes(camel) ? Number(value) : value;
    }
    if (!args.bucket && !args.out) {
        console.error('Usage: node scale-test/generate-test-bucket.js (--out <folder> | --bucket <name>) [--region us-east-1] [--files 300000] [--delete]');
        process.exit(1);
    }
    return args;
}

const HOUR = 3600e3;
const pad = (n) => String(n).padStart(2, '0');

/** One Bedrock model-invocation log line: a direct model call by an application role. */
function logLine({ account, region, at, i, role }) {
    return JSON.stringify({
        schemaType: 'ModelInvocationLog',
        schemaVersion: '1.0',
        timestamp: new Date(at).toISOString(),
        accountId: account,
        region,
        requestId: `scale-test-${at}-${i}`,
        operation: 'Converse',
        modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
        identity: { arn: `arn:aws:sts::${account}:assumed-role/${role}/scale-test-session` },
        input: {
            inputContentType: 'application/json',
            inputBodyJson: { messages: [{ role: 'user', content: [{ text: `Scale test question ${i}: what is the status of order ${1000 + i}?` }] }] },
            inputTokenCount: 18
        },
        output: {
            outputContentType: 'application/json',
            outputBodyJson: { output: { message: { role: 'assistant', content: [{ text: `Order ${1000 + i} has shipped and will arrive within three business days.` }] } }, stopReason: 'end_turn' },
            outputTokenCount: 16
        }
    });
}

/** Runs `task` over `items` with at most `limit` in flight. */
async function pool(items, limit, task, onProgress) {
    let next = 0, done = 0;
    const worker = async () => {
        while (next < items.length) {
            const item = items[next++];
            await task(item);
            done++;
            if (onProgress && done % 5000 === 0) onProgress(done);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function ensureBucket(s3, bucket, region) {
    try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }));
        console.log(`Bucket ${bucket} already exists — adding objects to it`);
    } catch {
        await s3.send(new CreateBucketCommand({
            Bucket: bucket,
            ...(region !== 'us-east-1' && { CreateBucketConfiguration: { LocationConstraint: region } })
        }));
        console.log(`Created bucket ${bucket} in ${region}`);
    }
}

async function deleteBucket(s3, bucket) {
    let continuationToken, deleted = 0;
    do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken }));
        const keys = (page.Contents || []).map((o) => ({ Key: o.Key }));
        if (keys.length) {
            await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }));
            deleted += keys.length;
            if (deleted % 50000 < 1000) console.log(`  deleted ${deleted}`);
        }
        continuationToken = page.NextContinuationToken;
    } while (continuationToken);
    await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
    console.log(`Deleted ${deleted} object(s) and bucket ${bucket}`);
}

/**
 * Writes every object to a local folder that mirrors the bucket, for `aws s3 sync`.
 * The dated folders are relative to NOW: generate right before uploading, or the "last
 * 24 hours" will no longer be the last 24 hours when the processor runs.
 */
async function writeLocal(outDir, objects, keyOf, recentBodyOf) {
    const historyBody = zlib.gzipSync('{"schemaType":"ModelInvocationLog","note":"history file - never read by v4.6"}\n');
    const startedAt = Date.now();
    const made = new Set();
    await pool(objects, 64, async (obj) => {
        const file = path.join(outDir, keyOf(obj));
        const dir = path.dirname(file);
        if (!made.has(dir)) { fs.mkdirSync(dir, { recursive: true }); made.add(dir); }
        await fs.promises.writeFile(file, recentBodyOf(obj) || historyBody);
    }, (done) => console.log(`  ${done}/${objects.length} written`));
    console.log(`\nDone: ${objects.length} file(s) in ${((Date.now() - startedAt) / 1000).toFixed(0)}s under ${outDir}/`);
    console.log('Upload within the next hour or two (the "last 24 hours" are relative to now):');
    console.log(`  aws s3 sync ${outDir} s3://<bucket>/ --only-show-errors`);
}

(async () => {
    const args = parseArgs(process.argv.slice(2));
    const s3 = new S3Client({ region: args.region });

    if (args.delete) {
        await deleteBucket(s3, args.bucket);
        return;
    }

    // The account ID goes into the key layout, exactly as Bedrock writes it. Writing to a
    // local folder needs no AWS at all, so it uses a placeholder unless one is given.
    const account = args.account || (args.out ? '123456789012' : null) || execFileSync('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], { encoding: 'utf8' }).trim();
    // --key-prefix: the prefix Bedrock's logging configuration writes under, if any.
    const keyPrefix = args.keyPrefix ? `${args.keyPrefix.replace(/\/+$/, '')}/` : '';
    const root = `${keyPrefix}AWSLogs/${account}/BedrockModelInvocationLogs/${args.region}/`;
    const now = Date.now();
    const currentHour = Math.floor(now / HOUR) * HOUR;
    const recentStart = currentHour - 23 * HOUR;
    const historyStart = currentHour - args.months * 30 * 24 * HOUR;

    // History: every hour folder before the last day, evenly filled up to --files.
    const historyHours = Math.max(1, Math.floor((recentStart - historyStart) / HOUR));
    const recentFiles = 24 * args.recentPerHour;
    const historyFiles = Math.max(0, args.files - recentFiles);
    const perHistoryHour = historyFiles / historyHours;

    const folder = (ms) => {
        const d = new Date(ms);
        return `${root}${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}/`;
    };
    const stamp = (ms) => new Date(ms).toISOString().replace(/[-:.]/g, '');

    const objects = [];
    for (let h = 0; h < historyHours; h++) {
        const hour = historyStart + h * HOUR;
        const count = Math.floor((h + 1) * perHistoryHour) - Math.floor(h * perHistoryHour);
        for (let i = 0; i < count; i++) objects.push({ at: hour + Math.floor((i * HOUR) / Math.max(1, count)), i, recent: false });
    }
    for (let h = 0; h < 24; h++) {
        const hour = recentStart + h * HOUR;
        for (let i = 0; i < args.recentPerHour; i++) objects.push({ at: hour + Math.floor((i * HOUR) / args.recentPerHour), i, recent: true });
    }

    console.log(`Account ${account}, region ${args.region}`);
    console.log(`Writing ${objects.length} log file(s) under ${args.out ? `${args.out}/` : `s3://${args.bucket}/`}${root}`);
    console.log(`  history: ${historyFiles} across ${historyHours} hour folders (${args.months} months) — must NOT be read by v4.6`);
    console.log(`  last 24h: ${recentFiles} (${args.recentPerHour}/hour) with realistic entries — what v4.6 should read`);
    console.log(`  estimated cost: ~$${((objects.length / 1000) * 0.005).toFixed(2)} in PUT requests; delete the bucket afterwards`);

    if (args.dryRun) {
        const keyOf = (obj) => `${folder(obj.at)}${stamp(obj.at)}_akto-scale-test-${String(obj.i).padStart(5, '0')}.json.gz`;
        console.log('\nDry run — nothing uploaded. Sample keys:');
        for (const obj of [objects[0], objects[Math.floor(historyFiles / 2)], objects[objects.length - 1]]) console.log(`  ${keyOf(obj)}`);
        console.log(`Sample recent log line:\n  ${logLine({ account, region: args.region, at: now, i: 1, role: 'akto-scale-test-app-role' }).slice(0, 220)}…`);
        return;
    }

    if (args.out) {
        await writeLocal(args.out, objects, (obj) => `${folder(obj.at)}${stamp(obj.at)}_akto-scale-test-${String(obj.i).padStart(5, '0')}.json.gz`,
            (obj) => (obj.recent
                ? zlib.gzipSync(`${logLine({ account, region: args.region, at: obj.at, i: obj.i, role: 'akto-scale-test-app-role' })}\n`)
                : null));
        return;
    }

    await ensureBucket(s3, args.bucket, args.region);

    // One tiny gzipped body reused for every history file: content is irrelevant there.
    const historyBody = zlib.gzipSync(`${logLine({ account, region: args.region, at: historyStart, i: 0, role: 'akto-scale-test-history-role' })}\n`);
    const startedAt = Date.now();
    await pool(objects, args.concurrency, async (obj) => {
        const body = obj.recent
            ? zlib.gzipSync(`${logLine({ account, region: args.region, at: obj.at, i: obj.i, role: 'akto-scale-test-app-role' })}\n`)
            : historyBody;
        await s3.send(new PutObjectCommand({
            Bucket: args.bucket,
            Key: `${folder(obj.at)}${stamp(obj.at)}_akto-scale-test-${String(obj.i).padStart(5, '0')}.json.gz`,
            Body: body,
            ContentType: 'application/x-gzip'
        }));
    }, (done) => {
        const rate = done / ((Date.now() - startedAt) / 1000);
        console.log(`  ${done}/${objects.length} uploaded (${rate.toFixed(0)}/s, ~${((objects.length - done) / rate / 60).toFixed(1)} min left)`);
    });

    console.log(`\nDone: ${objects.length} file(s) in ${((Date.now() - startedAt) / 60000).toFixed(1)} min`);
    console.log(`Stack parameters:  LogsBucketName=${args.bucket}  LogsPrefix=AWSLogs/  MarkersBucketName=${args.bucket}`);
})().catch((error) => {
    console.error(`Failed: ${error.name}: ${error.message}`);
    process.exit(1);
});
