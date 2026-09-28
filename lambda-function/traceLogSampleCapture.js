/**
 * Persists raw CloudWatch log events (for parser debugging) under the trace
 * markers prefix. Which groups are stored and at what watermark is tracked in
 * trace manifest.json → logGroupSamples — no re-upload until latestEventTimestamp advances.
 */
const crypto = require('crypto');
const { PutObjectCommand } = require('@aws-sdk/client-s3');
const config = require('./config');

const MAX_EVENTS = Number(process.env.TRACE_SAMPLE_MAX_EVENTS || 80);
const MAX_CAPTURES_PER_RUN = Number(process.env.TRACE_SAMPLE_MAX_CAPTURES_PER_RUN || 5);
const ENABLED = String(process.env.TRACE_LOG_SAMPLES_ENABLED || 'true').toLowerCase() !== 'false';

function sampleS3Key(logGroupName) {
    const hash = crypto.createHash('sha256').update(logGroupName).digest('hex').slice(0, 24);
    return `${config.TRACE_MARKERS_PREFIX}samples/${hash}.json`;
}

function needsSampleCapture(logGroupSamples, logGroupName, latestTimestamp) {
    const entry = logGroupSamples?.[logGroupName];
    if (!entry) return true;
    return latestTimestamp > (entry.latestEventTimestamp || 0);
}

/**
 * @param {object} state — mutable { capturesThisRun } for per-invocation cap
 * @returns {Promise<Record<string, object>>} updated logGroupSamples map
 */
async function captureLogGroupSampleIfNeeded(events, logGroup, meta, logGroupSamples, state) {
    if (!ENABLED || !events?.length) return logGroupSamples;
    if (state.capturesThisRun >= MAX_CAPTURES_PER_RUN) return logGroupSamples;

    const { latestTimestamp, sinceMs } = meta;
    if (!needsSampleCapture(logGroupSamples, logGroup.logGroupName, latestTimestamp)) {
        return logGroupSamples;
    }

    const sampleEvents = events.slice(0, MAX_EVENTS).map((e) => ({
        timestamp: e.timestamp,
        ingestionTime: e.ingestionTime,
        message: e.message
    }));

    const payload = {
        version: 1,
        codeVersion: config.CODE_VERSION,
        logGroupName: logGroup.logGroupName,
        runtimeId: logGroup.runtimeId,
        accountId: config.AWS_ACCOUNT_ID,
        region: config.AWS_REGION,
        sinceMs,
        latestEventTimestamp: latestTimestamp,
        fetchedEventCount: events.length,
        sampleEventCount: sampleEvents.length,
        capturedAt: new Date().toISOString(),
        events: sampleEvents
    };

    const key = sampleS3Key(logGroup.logGroupName);
    try {
        await config.markersS3Client.send(new PutObjectCommand({
            Bucket: config.MARKERS_BUCKET_NAME,
            Key: key,
            Body: JSON.stringify(payload, null, 2),
            ContentType: 'application/json'
        }));
        const updated = { ...logGroupSamples };
        updated[logGroup.logGroupName] = {
            s3Key: key,
            latestEventTimestamp: latestTimestamp,
            capturedAt: payload.capturedAt,
            sampleEventCount: sampleEvents.length,
            fetchedEventCount: events.length
        };
        state.capturesThisRun += 1;
        console.log(
            `📦 Trace log sample saved: ${logGroup.logGroupName} → s3://${config.MARKERS_BUCKET_NAME}/${key} `
            + `(${sampleEvents.length}/${events.length} events, watermark=${latestTimestamp})`
        );
        return updated;
    } catch (error) {
        console.error(`⚠️ Failed to save trace log sample for ${logGroup.logGroupName}: ${error.message}`);
        return logGroupSamples;
    }
}

module.exports = { captureLogGroupSampleIfNeeded, needsSampleCapture, sampleS3Key };
