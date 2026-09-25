/**
 * Orders AgentCore observability log groups for each run: never-checkpointed
 * groups first, then checkpointed groups rotated from logGroupWalkCursor so we
 * do not re-walk the full list from index 0 every invocation.
 */

function byLogGroupName(a, b) {
    return a.logGroupName.localeCompare(b.logGroupName);
}

/**
 * @param {Array<{logGroupName: string}>} allGroups
 * @param {Record<string, object>} logGroupCheckpoints
 * @param {string} walkCursor — last logGroupName processed on the checked queue (may be empty)
 */
function orderLogGroupsForWalk(allGroups, logGroupCheckpoints, walkCursor = '') {
    const unchecked = [];
    const checked = [];
    for (const group of allGroups) {
        if (logGroupCheckpoints[group.logGroupName]) checked.push(group);
        else unchecked.push(group);
    }
    unchecked.sort(byLogGroupName);
    checked.sort(byLogGroupName);

    let rotatedChecked = checked;
    if (walkCursor) {
        const idx = checked.findIndex((g) => g.logGroupName === walkCursor);
        if (idx >= 0) {
            rotatedChecked = checked.slice(idx + 1).concat(checked.slice(0, idx + 1));
        }
    }

    return {
        groups: unchecked.concat(rotatedChecked),
        uncheckedCount: unchecked.length,
        checkedCount: checked.length
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
