/**
 * Discovers AgentCore observability log groups in CloudWatch Logs and reads
 * new log events out of them. Purely a CloudWatch Logs client — record
 * parsing/classification is traceParser.js's job.
 */
const { DescribeLogGroupsCommand, FilterLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const config = require('./config');
const { RUNTIME_LOG_GROUP_PREFIX, MAX_LOG_EVENTS_PER_FETCH } = config;

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
            const response = await config.cloudWatchLogsClient.send(new DescribeLogGroupsCommand({
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
 * Fetches every new log event in one log group since sinceMs, paginating via
 * nextToken. No stream-name filter — scans the whole group and lets
 * traceParser.js discriminate records by shape. Returns
 * { events, latestTimestamp } so the caller can checkpoint even on a partial
 * fetch cut short by the time budget.
 */
async function fetchNewLogEvents(logGroupName, sinceMs, timeLeft, timeSafetyMarginMs) {
    const events = [];
    let latestTimestamp = sinceMs;
    let nextToken;
    try {
        do {
            if (timeLeft() < timeSafetyMarginMs) {
                console.warn(`⏱️ Time budget low — deferring remaining pages for ${logGroupName}`);
                break;
            }
            const response = await config.cloudWatchLogsClient.send(new FilterLogEventsCommand({
                logGroupName,
                startTime: sinceMs + 1, // +1ms: startTime is inclusive, avoids re-fetching the last event already processed
                limit: MAX_LOG_EVENTS_PER_FETCH,
                nextToken
            }));
            for (const event of response.events || []) {
                events.push(event);
                if (event.timestamp > latestTimestamp) latestTimestamp = event.timestamp;
            }
            nextToken = response.nextToken;
        } while (nextToken);
    } catch (error) {
        console.error(`❌ FilterLogEvents failed for ${logGroupName}: ${error.message}`);
    }
    return { events, latestTimestamp };
}

module.exports = { discoverObservabilityLogGroups, fetchNewLogEvents, extractRuntimeIdFromLogGroupName };
