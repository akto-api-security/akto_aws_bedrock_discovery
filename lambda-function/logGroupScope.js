/**
 * Narrows AgentCore CloudWatch log groups before the walk loop.
 *
 * AWS creates one log group per runtime endpoint under
 * /aws/bedrock-agentcore/runtimes/<agent_id>-<endpoint> (see AgentCore
 * observability docs). Accounts with heavy CI churn can have tens of thousands
 * of historical groups; ingest only needs groups for harnesses/runtimes we
 * discover via AgentCore control plane APIs.
 */

const { RUNTIME_LOG_GROUP_PREFIX } = require('./config');

/** @typedef {'discovered' | 'all'} TraceLogGroupScope */

/**
 * @param {Record<string, { resourceType?: string, resourceId?: string }>} discoveredAgents
 * @returns {Set<string>}
 */
function buildDiscoveredRuntimeIdSet(discoveredAgents) {
    const ids = new Set();
    for (const entry of Object.values(discoveredAgents || {})) {
        if (entry?.resourceType !== 'RUNTIME' && entry?.resourceType !== 'HARNESS') continue;
        if (entry.resourceId) ids.add(entry.resourceId);
    }
    return ids;
}

/**
 * @param {{ logGroupName: string, runtimeId?: string }} logGroup
 * @param {Set<string>} runtimeIds
 * @param {string} prefix
 */
function logGroupMatchesDiscoveredRuntime(logGroup, runtimeIds, prefix) {
    if (runtimeIds.size === 0) return true;
    const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
    if (logGroup.runtimeId && runtimeIds.has(logGroup.runtimeId)) return true;
    for (const id of runtimeIds) {
        if (logGroup.logGroupName.startsWith(`${normalizedPrefix}${id}-`)) return true;
    }
    return false;
}

/**
 * @param {string} logGroupName
 * @param {string[]} includeSubstrings — if non-empty, name must contain at least one
 * @param {string[]} excludeSubstrings
 */
function passesSubstringFilters(logGroupName, includeSubstrings, excludeSubstrings) {
    if (excludeSubstrings.some((s) => logGroupName.includes(s))) return false;
    if (includeSubstrings.length > 0 && !includeSubstrings.some((s) => logGroupName.includes(s))) {
        return false;
    }
    return true;
}

/**
 * After an empty FilterLogEvents, skip re-polling for a cooldown window.
 * @param {object} [checkpoint]
 * @param {number} nowMs
 * @param {number} cooldownHours — 0 disables
 */
function isOnEmptyPollCooldown(checkpoint, nowMs, cooldownHours) {
    if (!cooldownHours || cooldownHours <= 0 || !checkpoint?.lastEmptyPollAt) return false;
    const polledAt = Date.parse(checkpoint.lastEmptyPollAt);
    if (Number.isNaN(polledAt)) return false;
    return (nowMs - polledAt) < cooldownHours * 60 * 60 * 1000;
}

/**
 * @param {Array<{ logGroupName: string, runtimeId?: string }>} allGroups
 * @param {object} options
 * @param {Record<string, object>} options.discoveredAgents
 * @param {Record<string, object>} options.logGroupCheckpoints
 * @param {TraceLogGroupScope} options.scope
 * @param {string[]} options.includeSubstrings
 * @param {string[]} options.excludeSubstrings
 * @param {number} options.emptyPollCooldownHours
 * @param {number} nowMs
 */
function filterLogGroupsForIngest(allGroups, options, nowMs = Date.now()) {
    const {
        discoveredAgents,
        logGroupCheckpoints,
        scope,
        includeSubstrings,
        excludeSubstrings,
        emptyPollCooldownHours
    } = options;

    const runtimeIds = buildDiscoveredRuntimeIdSet(discoveredAgents);
    const useDiscoveredScope = scope === 'discovered';
    let fallbackToAll = false;
    if (useDiscoveredScope && runtimeIds.size === 0) {
        fallbackToAll = true;
    }

    const stats = {
        listed: allGroups.length,
        selected: 0,
        skippedOrphan: 0,
        skippedInclude: 0,
        skippedExclude: 0,
        skippedEmptyCooldown: 0,
        scope: fallbackToAll ? 'all (no discovered runtimes yet)' : scope,
        discoveredRuntimeIds: runtimeIds.size
    };

    const groups = [];
    for (const logGroup of allGroups) {
        if (!passesSubstringFilters(logGroup.logGroupName, includeSubstrings, excludeSubstrings)) {
            if (excludeSubstrings.some((s) => logGroup.logGroupName.includes(s))) {
                stats.skippedExclude++;
            } else {
                stats.skippedInclude++;
            }
            continue;
        }

        if (useDiscoveredScope && !fallbackToAll
            && !logGroupMatchesDiscoveredRuntime(logGroup, runtimeIds, RUNTIME_LOG_GROUP_PREFIX)) {
            stats.skippedOrphan++;
            continue;
        }

        const checkpoint = logGroupCheckpoints?.[logGroup.logGroupName];
        if (isOnEmptyPollCooldown(checkpoint, nowMs, emptyPollCooldownHours)) {
            stats.skippedEmptyCooldown++;
            continue;
        }

        groups.push(logGroup);
        stats.selected++;
    }

    return { groups, stats };
}

module.exports = {
    buildDiscoveredRuntimeIdSet,
    logGroupMatchesDiscoveredRuntime,
    passesSubstringFilters,
    isOnEmptyPollCooldown,
    filterLogGroupsForIngest
};
