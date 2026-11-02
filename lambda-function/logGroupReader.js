/**
 * Discovers AgentCore observability log groups in CloudWatch Logs and reads
 * new log events out of them. Purely a CloudWatch Logs client — record
 * parsing/classification is traceParser.js's job.
 */
const { DescribeLogGroupsCommand, FilterLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const { cloudWatchLogsClient, RUNTIME_LOG_GROUP_PREFIX, MAX_LOG_EVENTS_PER_FETCH } = require('./config');

/**
 * Pulls the runtime ID out of a per-runtime log group name:
 * /aws/bedrock-agentcore/runtimes/<runtime-id>-<endpoint>. Fallback only —
 * traceParser.js normally reads the runtime ARN directly off each record's
 * resource attributes. Assumes the endpoint name has no hyphens.
 */
function extractRuntimeIdFromLogGroupName(logGroupName) {
    const match = logGroupName?.match(/\/aws\/bedrock-agentcore\/runtimes\/(.+)-([^-/]+)$/);
    return match ? match[1] : '';
}

/**
 * Lists every per-runtime observability log group. Returns [] (not a throw)
 * if AgentCore tracing isn't enabled on this account.
 */
async function discoverObservabilityLogGroups() {
    const logGroups = [];
    try {
        let nextToken;
        do {
            const response = await cloudWatchLogsClient.send(new DescribeLogGroupsCommand({
                logGroupNamePrefix: RUNTIME_LOG_GROUP_PREFIX,
                nextToken
            }));
            for (const group of response.logGroups || []) {
                logGroups.push({ logGroupName: group.logGroupName, runtimeId: extractRuntimeIdFromLogGroupName(group.logGroupName) });
            }
            nextToken = response.nextToken;
        } while (nextToken);
    } catch (error) {
        console.error(`❌ DescribeLogGroups failed for prefix ${RUNTIME_LOG_GROUP_PREFIX} (check logs:DescribeLogGroups permission): ${error.message}`);
    }

    console.log(`🔎 Found ${logGroups.length} per-runtime observability log group(s)`);
    return logGroups;
}

/**
 * Reads every new log event in one log group since sinceMs and hands them to onChunk
 * in groups of about chunkSize, oldest first, so a busy log group is never held in
 * memory in full. Stops early when the time budget runs low; the next run resumes.
 *
 * onChunk(events, checkpointMs) must process the events and then record checkpointMs
 * as the group's lastEventTimestamp — the next fetch starts just after it. The
 * checkpoint is chosen so nothing is skipped: when a chunk is cut while events remain,
 * the events sharing its final millisecond are carried into the next chunk (or the next
 * run), because FilterLogEvents resumes strictly after the checkpoint and would never
 * return the rest of that millisecond.
 *
 * Returns the number of events read.
 */
async function readNewLogEventsInChunks(logGroupName, sinceMs, { timeLeft, timeSafetyMarginMs, chunkSize, onChunk }) {
    let pending = [];
    let total = 0;
    let nextToken;
    let complete = false;

    // Everything in `pending` except its final millisecond, which may continue on the
    // next page. If the whole chunk is one millisecond there is no safe cut, so it goes
    // out whole rather than growing without bound.
    const flushSettled = async () => {
        const lastMs = pending[pending.length - 1].timestamp;
        const settled = pending.filter((event) => event.timestamp < lastMs);
        if (settled.length === 0) {
            await onChunk(pending, lastMs);
            pending = [];
            return;
        }
        pending = pending.slice(settled.length);
        await onChunk(settled, lastMs - 1);
    };

    do {
        if (timeLeft() < timeSafetyMarginMs) {
            console.warn(`⏱️ Time budget low — deferring remaining pages for ${logGroupName}`);
            break;
        }
        let response;
        try {
            response = await cloudWatchLogsClient.send(new FilterLogEventsCommand({
                logGroupName,
                startTime: sinceMs + 1, // +1ms: startTime is inclusive, avoids re-fetching the last event already processed
                limit: MAX_LOG_EVENTS_PER_FETCH,
                nextToken
            }));
        } catch (error) {
            // What was already read is still processed; the rest is fetched next run.
            console.error(`❌ FilterLogEvents failed for ${logGroupName}: ${error.message}`);
            break;
        }
        for (const event of response.events || []) pending.push(event);
        total += (response.events || []).length;
        nextToken = response.nextToken;
        complete = !nextToken;
        // A failure in onChunk (e.g. AKTO unreachable) propagates, exactly as a failed
        // send did before — the group's checkpoint stays where it was.
        if (!complete && pending.length >= chunkSize) await flushSettled();
    } while (nextToken);

    if (pending.length > 0) {
        if (complete) await onChunk(pending, pending[pending.length - 1].timestamp);
        else await flushSettled();
    }
    return total;
}

module.exports = { discoverObservabilityLogGroups, readNewLogEventsInChunks, extractRuntimeIdFromLogGroupName };
