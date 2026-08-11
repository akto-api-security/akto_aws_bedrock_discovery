/**
 * Bedrock Agent (Classic) discovery, plus tag and IAM-role enrichment for
 * discovery messages and real conversation messages. Owns the per-invocation
 * in-memory caches that avoid repeat API calls for the same resource within
 * one Lambda run.
 *
 * AgentCore Harness/Runtime discovery and conversation extraction live in
 * traceDiscovery.js/logGroupReader.js/traceParser.js instead (CloudWatch
 * traces, not S3 logs) — this module only ever produces resourceType/logType
 * 'AGENT'.
 */
const { GetAgentCommand, ListAgentsCommand, ListTagsForResourceCommand: BedrockAgentListTagsCommand } = require('@aws-sdk/client-bedrock-agent');
const { ListAttachedRolePoliciesCommand } = require('@aws-sdk/client-iam');
const { AWS_REGION, AWS_ACCOUNT_ID, TIME_SAFETY_MARGIN_MS, bedrockAgentClient, iamClient } = require('./config');
const { buildAgentMessage } = require('./messageBuilder');

const agentNameCache = {};
const tagsCache = {};

// Role-based mappings for log processing (discovery source is source of truth for type)
// roleName -> [{agentId, agentName, type: 'AGENT', agentArn}, ...]
const roleToResourcesMap = {};
// Distinct roles/agents already reported this run — keeps the log to one line each.
const reportedNonAgentRoles = new Set();
const reportedAmbiguousRoles = new Set();

/** How each log entry's identity was resolved — reported once per run, not per entry. */
const identityStats = {
    resolvedByRole: 0,          // role maps to exactly one agent — the normal path
    resolvedBySession: 0,       // shared role, narrowed by the agent ID in the session name
    ambiguousSkips: 0,          // shared role the session name couldn't narrow
    nonAgentSkips: 0            // role belongs to no agent at all
};

/** Generic pager: calls sendPage(nextToken) until no token comes back, concatenating pluck(response) from each page. */
async function listAllPages(sendPage, pluck) {
    let items = [];
    let nextToken;
    do {
        const response = await sendPage(nextToken);
        items = items.concat(pluck(response) || []);
        nextToken = response.nextToken;
    } while (nextToken);
    return items;
}

/** Lists every Bedrock Agent in the account. Returns [] (not a throw) if the API call fails. */
async function listAllAgents() {
    try {
        return await listAllPages(
            (nextToken) => bedrockAgentClient.send(new ListAgentsCommand({ nextToken })),
            (response) => response.agentSummaries
        );
    } catch (error) {
        console.error(`❌ ListAgents failed (check bedrock:ListAgents permission): ${error.message}`);
        return [];
    }
}

/** Fetches full metadata for one agent. Returns null on failure. */
async function getAgentMetadata(agentId) {
    try {
        return (await bedrockAgentClient.send(new GetAgentCommand({ agentId }))).agent;
    } catch (error) {
        console.error(`❌ GetAgent failed for ${agentId}: ${error.message}`);
        return null;
    }
}

/** Generic cached tag-fetch wrapper — every AKTO tag lookup follows this exact shape. */
async function fetchTagsCached(cacheKey, fetcher) {
    if (tagsCache[cacheKey]) return tagsCache[cacheKey];
    const tags = await fetcher();
    tagsCache[cacheKey] = tags;
    return tags;
}

/** Fetches AWS resource tags for one Bedrock Agent. */
async function getBedrockAgentTags(agentId) {
    try {
        const arn = `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:agent/${agentId}`;
        return (await bedrockAgentClient.send(new BedrockAgentListTagsCommand({ resourceArn: arn }))).tags || {};
    } catch (error) {
        console.error(`⚠️ Tag fetch failed for agent ${agentId}: ${error.message}`);
        return {};
    }
}

/** Adds the agent's execution role ARN + its attached policy names to a tag set. */
async function addAgentRoleAndPermissions(tags, agentId) {
    try {
        const agentDetails = await bedrockAgentClient.send(new GetAgentCommand({ agentId }));
        const roleArn = agentDetails.agent?.agentResourceRoleArn || agentDetails.agent?.executionRoleArn || '';
        if (!roleArn) {
            console.warn(`⚠️ No execution role found for agent ${agentId}`);
            return tags;
        }
        const roleName = extractRoleNameFromArn(roleArn);
        return { ...tags, 'bedrock-execution-role-arn': roleArn, 'bedrock-execution-role': roleName, 'bedrock-role-policies': await getRolePolicies(roleName) };
    } catch (error) {
        console.error(`⚠️ Role lookup failed for agent ${agentId}: ${error.message}`);
        return tags;
    }
}

/** Lists a role's attached managed policy names, cached per role for the lifetime of the invocation. */
async function getRolePolicies(roleName) {
    const cacheKey = `role-policies-${roleName}`;
    if (tagsCache[cacheKey]) return tagsCache[cacheKey];
    try {
        const response = await iamClient.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
        const policies = response.AttachedPolicies?.map((p) => p.PolicyName).join(',') || '';
        tagsCache[cacheKey] = policies;
        return policies;
    } catch (error) {
        console.error(`⚠️ Policy list failed for role ${roleName}: ${error.message}`);
        return '';
    }
}

/** Extracts the role name from the end of an IAM role ARN. */
function extractRoleNameFromArn(roleArn) {
    return roleArn ? roleArn.split('/').pop() : '';
}

/** Resolves an agent's display name from its ID, cached across the invocation. */
async function fetchAgentName(agentId) {
    if (!agentId) return '';
    if (agentNameCache[agentId]) return agentNameCache[agentId];
    try {
        const details = await bedrockAgentClient.send(new GetAgentCommand({ agentId }));
        const name = details?.agent?.agentName || details?.agentName || '';
        if (name) agentNameCache[agentId] = name;
        return name;
    } catch (error) {
        console.error(`⚠️ Agent name fetch failed for ${agentId}: ${error.message}`);
        return '';
    }
}

/**
 * Builds one AKTO message from a real conversation pair: resolves the bot name,
 * fetches and enriches agent tags, then hands everything to buildAgentMessage.
 */
async function createStandardMessage(pair) {
    if (pair.logType === 'AGENT') pair.botName = await fetchAgentName(pair.agentId);

    let agentTags = {};
    const harnessTags = {};
    let awsMetadata = {};

    if (pair.logType === 'AGENT' && pair.agentId) {
        agentTags = await fetchTagsCached(`agent-${pair.agentId}`, () => getBedrockAgentTags(pair.agentId));
        agentTags = await addAgentRoleAndPermissions(agentTags, pair.agentId);
        awsMetadata = {
            model: pair.modelId,
            'bedrock-execution-role': agentTags['bedrock-execution-role'] || '',
            traceData: pair.traceData || {}
        };
    }

    return buildAgentMessage({ ...pair, accountId: pair.accountId || AWS_ACCOUNT_ID, region: pair.region || AWS_REGION, agentTags, harnessTags, awsMetadata }, true);
}

/**
 * Discovers agents not yet in `discoveredAgents` (mutated in place) and
 * returns metadata-only messages for them. Bails early if the time budget is
 * running low — anything not yet discovered stays absent from `discoveredAgents`,
 * so it's picked up automatically on the next invocation.
 */
async function discoverAllNewAgents(discoveredAgents, timeLeft) {
    const messages = [];

    const agents = await listAllAgents();
    for (const agent of agents) {
        if (timeLeft() < TIME_SAFETY_MARGIN_MS) { console.warn('⏱️ Time budget low — deferring remaining agent discovery'); return messages; }
        const key = `agent-${agent.agentId}`;
        if (discoveredAgents[key]) continue;
        try {
            const metadata = await getAgentMetadata(agent.agentId);
            if (!metadata) continue;
            let agentTags = await fetchTagsCached(`agent-${agent.agentId}`, () => getBedrockAgentTags(agent.agentId));
            agentTags = await addAgentRoleAndPermissions(agentTags, agent.agentId);
            const arn = metadata.agentArn || `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:agent/${agent.agentId}`;
            messages.push(buildAgentMessage({ ...metadata, resourceType: 'AGENT', arn, agentTags, harnessTags: {} }, false));
            // The execution role is persisted with the agent so the role map can be
            // rebuilt from the manifest instead of re-querying every agent each run —
            // and so "which role belongs to which agent" is answerable from the
            // manifest rather than by reading logs.
            discoveredAgents[key] = {
                resourceId: agent.agentId,
                resourceType: 'AGENT',
                resourceName: agent.agentName,
                foundationModel: metadata.foundationModel,
                agentArn: arn,
                executionRoleArn: metadata.agentResourceRoleArn || '',
                roleName: metadata.agentResourceRoleArn ? extractRoleNameFromArn(metadata.agentResourceRoleArn) : '',
                discoveredAt: new Date().toISOString()
            };

            // Build role mapping for log processing
            if (metadata.agentResourceRoleArn) {
                const roleName = extractRoleNameFromArn(metadata.agentResourceRoleArn);
                if (roleName) {
                    if (!roleToResourcesMap[roleName]) roleToResourcesMap[roleName] = [];
                    roleToResourcesMap[roleName].push({
                        agentId: agent.agentId,
                        agentName: agent.agentName,
                        type: 'AGENT',
                        agentArn: arn
                    });
                    console.log(`✅ Mapped agent role '${roleName}' (from ${metadata.agentResourceRoleArn}) → agent '${agent.agentName}'`);
                } else {
                    console.warn(`⚠️ Could not extract role name from ARN: ${metadata.agentResourceRoleArn}`);
                }
            }
        } catch (error) {
            console.error(`⚠️ Discovery failed for agent ${agent.agentId}: ${error.message}`);
        }
    }

    return messages;
}

/**
 * Finds the agent a log entry belongs to, from its STS ARN.
 *
 * The execution role is the primary key: nearly every agent has its own, so the
 * role map answers this outright. The session name is consulted only as a fallback,
 * for the one case the role can't settle — several agents sharing a role.
 *
 * Returns null when the traffic isn't an agent's, or when a shared role can't be
 * narrowed to a single agent.
 */
function findResourceByArn(stsArn) {
    if (!stsArn) return null;

    const roleNameMatch = stsArn.match(/assumed-role\/([^/]+)/);
    if (!roleNameMatch) {
        console.warn(`⚠️ Could not extract role name from ARN: ${stsArn}`);
        return null;
    }
    const roleName = roleNameMatch[1];
    const sessionName = (stsArn.match(/assumed-role\/[^/]+\/(.+)$/) || [])[1] || '';
    const resources = roleToResourcesMap[roleName];

    // No agent owns this role, so this traffic came from an application or a person
    // calling a model directly — out of scope for this pipeline, and skipped.
    // Logged once per distinct role rather than once per log entry: a busy account
    // has thousands of such entries and only a handful of roles. The session name is
    // included because that is what identifies the caller.
    if (!resources || resources.length === 0) {
        identityStats.nonAgentSkips++;
        if (!reportedNonAgentRoles.has(roleName)) {
            reportedNonAgentRoles.add(roleName);
            console.log(`ℹ️ '${roleName}' is not an agent execution role — its traffic is not agent traffic and is skipped (caller: ${sessionName || 'unknown session'})`);
        }
        return null;
    }

    // Exactly one agent on this role — the role alone is enough, and the session
    // name is not looked at. This is the path essentially all traffic takes.
    if (resources.length === 1) {
        identityStats.resolvedByRole++;
        return resources[0];
    }

    /*
     *
     * Bedrock mints a fresh session name per invocation and stamps the invoked
     * agent's ID into it, so four agents on one role produce four distinct session
     * names, each naming its own agent. Matched case-insensitively: the cost is
     * nothing and a casing change upstream would otherwise turn into a silent skip.
     */
    const agentIdFromSession = (sessionName.match(/^BedrockAgents-([A-Za-z0-9]+)-/i) || [])[1];
    if (agentIdFromSession) {
        const named = resources.find((r) => String(r.agentId).toLowerCase() === agentIdFromSession.toLowerCase());
        if (named) {
            identityStats.resolvedBySession++;
            return named;
        }
    }

    /*
     * Either the session carries no agent ID, or it names an agent that isn't among
     * the ones known to share this role (not discovered yet). Both leave nothing
     * reliable to attribute by, so the entry is skipped rather than guessed at.
     *
     * Counted always, logged once per role: a busy shared role would otherwise
     * produce thousands of identical lines.
     */
    identityStats.ambiguousSkips++;
    if (!reportedAmbiguousRoles.has(roleName)) {
        reportedAmbiguousRoles.add(roleName);
        const why = agentIdFromSession
            ? `names agent '${agentIdFromSession}', which is not among them (not discovered yet)`
            : `carries no agent ID`;
        console.warn(`⚠️ Role '${roleName}' is shared by ${resources.length} agents (${resources.map((r) => r.agentName).join(', ')}) and the session name '${sessionName}' ${why} — cannot attribute, skipping these entries`);
    }
    return null;
}

/**
 * Rebuilds roleToResourcesMap from already-discovered agents.
 * Called at startup to ensure log processing can find agents discovered in previous runs.
 * Prevents the bug where an agent discovered in run 1 becomes "unknown" in run 2+ because
 * its role was never added to the in-memory roleToResourcesMap.
 */
async function rebuildRoleMapFromDiscoveredAgents(discoveredAgents, timeLeft) {
    let fromManifest = 0;
    let backfilled = 0;

    for (const [key, entry] of Object.entries(discoveredAgents)) {
        if (entry?.resourceType !== 'AGENT' || !entry.resourceId) continue;

        let { roleName, executionRoleArn, agentArn } = entry;

        // Agents discovered before the role was persisted need one lookup — after
        // which it's written back and never fetched again. Everything else is
        // rebuilt straight from the manifest, so this loop makes zero API calls in
        // the steady state and can't be left half-built by the time budget.
        if (!roleName) {
            if (timeLeft && timeLeft() < TIME_SAFETY_MARGIN_MS) {
                console.warn(`⏱️ Time budget low — ${Object.keys(discoveredAgents).length - fromManifest - backfilled} agent(s) still need a role backfill, deferring to next run`);
                break;
            }
            try {
                const metadata = await getAgentMetadata(entry.resourceId);
                if (!metadata?.agentResourceRoleArn) continue;
                executionRoleArn = metadata.agentResourceRoleArn;
                roleName = extractRoleNameFromArn(executionRoleArn);
                agentArn = metadata.agentArn || agentArn || `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:agent/${entry.resourceId}`;
                // Persisted on the next checkpoint.
                Object.assign(discoveredAgents[key], { executionRoleArn, roleName, agentArn });
                backfilled++;
            } catch (error) {
                console.error(`⚠️ Role backfill failed for agent ${entry.resourceId}: ${error.message}`);
                continue;
            }
        } else {
            fromManifest++;
        }

        if (!roleName) continue;
        if (!roleToResourcesMap[roleName]) roleToResourcesMap[roleName] = [];
        roleToResourcesMap[roleName].push({
            agentId: entry.resourceId,
            agentName: entry.resourceName,
            type: 'AGENT',
            agentArn: agentArn || `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:agent/${entry.resourceId}`
        });
    }
    if (backfilled > 0) console.log(`🔧 Backfilled the execution role for ${backfilled} agent(s) — persisted, so this won't repeat`);
    console.log(`📋 Role map source: ${fromManifest} from manifest, ${backfilled} fetched`);

    const roleList = Object.entries(roleToResourcesMap).map(([role, resources]) =>
        `${role}: ${resources.map(r => `${r.agentName}(${r.type})`).join(', ')}`
    );
    console.log(`✅ Role map rebuilt: ${roleList.length} role(s) mapped`);
    // Only print the map when there's something in it — an empty header followed by
    // a blank line reads like a failure when it just means no agents yet.
    if (roleList.length > 0) {
        console.log(`📋 Role map:\n${roleList.map((r) => `  ├─ ${r}`).join('\n')}`);
    }
}

/** Clears per-run log de-duplication so a warm container doesn't stay silent. */
function resetRunLogState() {
    reportedNonAgentRoles.clear();
    reportedAmbiguousRoles.clear();
    for (const key of Object.keys(identityStats)) identityStats[key] = 0;
}

/** Snapshot of how identities resolved this run. */
function getIdentityStats() { return { ...identityStats }; }

module.exports = {
    resetRunLogState, getIdentityStats, rebuildRoleMapFromDiscoveredAgents, discoverAllNewAgents, createStandardMessage,
    fetchAgentName, findResourceByArn
};
