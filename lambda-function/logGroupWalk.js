/**
 * Orders AgentCore observability log groups for each run by conversation
 * signal priority (manifest hints + inttest boost), then name.
 */

const { computeWalkPriority } = require('./logGroupConversationSignal');

function byLogGroupName(a, b) {
    return a.logGroupName.localeCompare(b.logGroupName);
}

/**
 * @param {Array<{logGroupName: string}>} allGroups
 * @param {Record<string, object>} logGroupCheckpoints
 * @param {string} _walkCursor — retained for manifest compatibility; ordering is priority-based
 */
function orderLogGroupsForWalk(allGroups, logGroupCheckpoints, _walkCursor = '') {
    const groups = [...allGroups].sort((a, b) => {
        const pa = computeWalkPriority(a, logGroupCheckpoints[a.logGroupName]);
        const pb = computeWalkPriority(b, logGroupCheckpoints[b.logGroupName]);
        if (pb !== pa) return pb - pa;
        return byLogGroupName(a, b);
    });
    const uncheckedCount = allGroups.filter((g) => !logGroupCheckpoints[g.logGroupName]).length;

    return {
        groups,
        uncheckedCount,
        checkedCount: allGroups.length - uncheckedCount
    };
}

/** After a successful FilterLogEvents with no events, advance so the group leaves the unchecked set. */
function checkpointEmptyLogGroupPoll(logGroupCheckpoints, logGroup, polledThroughMs) {
    logGroupCheckpoints[logGroup.logGroupName] = {
        lastEventTimestamp: polledThroughMs,
        runtimeId: logGroup.runtimeId,
        lastEmptyPollAt: new Date().toISOString()
    };
}

module.exports = { orderLogGroupsForWalk, checkpointEmptyLogGroupPoll };
