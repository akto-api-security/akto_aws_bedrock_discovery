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
const roleToResourcesMap = {}; // roleName -> [{agentId, agentName, type: 'AGENT', agentArn}, ...]

/** Lists every Bedrock Agent in the account. Returns [] (not a throw) if the API call fails. */
async function listAllAgents() {
    try {
        const response = await bedrockAgentClient.send(new ListAgentsCommand({}));
        return response.agentSummaries || [];
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
    pair.botName = pair.logType === 'AGENT' ? await fetchAgentName(pair.agentId) : '';

    let agentTags = {};
    const harnessTags = {};
    const awsMetadata = {};

    if (pair.logType === 'AGENT' && pair.agentId) {
        agentTags = await fetchTagsCached(`agent-${pair.agentId}`, () => getBedrockAgentTags(pair.agentId));
        agentTags = await addAgentRoleAndPermissions(agentTags, pair.agentId);
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
            discoveredAgents[key] = { resourceId: agent.agentId, resourceType: 'AGENT', resourceName: agent.agentName, foundationModel: metadata.foundationModel, discoveredAt: new Date().toISOString() };

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
 * Finds a resource (agent) from a log STS ARN by:
 * 1. Trying to extract agent ID from session name (if present)
 * 2. Looking up by role name in the map
 * Returns null if not found or ambiguous (multiple resources on same role without determinable ID).
 */
function findResourceByArn(stsArn) {
    if (!stsArn) return null;

    // Extract role name from STS ARN
    const roleNameMatch = stsArn.match(/assumed-role\/([^\/]+)/);
    if (!roleNameMatch) {
        console.warn(`⚠️ Could not extract role name from ARN: ${stsArn}`);
        return null;
    }
    const roleName = roleNameMatch[1];
    console.log(`🔍 Searching for role: '${roleName}' | Available roles: ${Object.keys(roleToResourcesMap).join(', ')}`);

    // Try to extract agent ID from session name (format: BedrockAgents-AGENT_ID-...)
    const sessionNameMatch = stsArn.match(/assumed-role\/[^\/]+\/(.+)$/);
    if (sessionNameMatch) {
        const sessionName = sessionNameMatch[1];
        const agentIdMatch = sessionName.match(/^BedrockAgents-([A-Z0-9]+)-/);
        if (agentIdMatch) {
            const agentId = agentIdMatch[1];
            const resources = roleToResourcesMap[roleName];
            if (resources) {
                const found = resources.find(r => r.agentId === agentId);
                if (found) {
                    console.log(`✅ Found agent by ID in session name: ${found.agentName}`);
                    return found;
                }
            }
        }
    }

    // Look up by role name
    const resources = roleToResourcesMap[roleName];

    // No resources found
    if (!resources) {
        console.warn(`⚠️ Unknown role: '${roleName}'. Available: ${Object.keys(roleToResourcesMap).join(', ')}`);
        return null;
    }

    // Exactly one resource on this role
    if (resources.length === 1) {
        console.log(`✅ Found resource by role name: ${resources[0].agentName}`);
        return resources[0];
    }

    // Multiple resources on same role - cannot determine which one
    console.warn(
        `⚠️ Role '${roleName}' maps to ${resources.length} resources (${resources.map(r => r.agentName).join(', ')}). ` +
        `Cannot determine correct mapping from session name. Skipping log entry.`
    );
    return null;
}

/**
 * Rebuilds roleToResourcesMap from already-discovered agents.
 * Called at startup to ensure log processing can find agents discovered in previous runs.
 * Prevents the bug where an agent discovered in run 1 becomes "unknown" in run 2+ because
 * its role was never added to the in-memory roleToResourcesMap.
 */
async function rebuildRoleMapFromDiscoveredAgents(discoveredAgents, timeLeft) {
    const agents = await listAllAgents();
    for (const agent of agents) {
        if (timeLeft && timeLeft() < TIME_SAFETY_MARGIN_MS) {
            console.warn('⏱️ Time budget low — deferring role map rebuild');
            return;
        }

        const key = `agent-${agent.agentId}`;
        if (!discoveredAgents[key]) continue;

        try {
            const metadata = await getAgentMetadata(agent.agentId);
            if (!metadata || !metadata.agentResourceRoleArn) continue;

            const roleName = extractRoleNameFromArn(metadata.agentResourceRoleArn);
            if (roleName) {
                if (!roleToResourcesMap[roleName]) roleToResourcesMap[roleName] = [];
                roleToResourcesMap[roleName].push({
                    agentId: agent.agentId,
                    agentName: agent.agentName,
                    type: 'AGENT',
                    agentArn: metadata.agentArn || `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:agent/${agent.agentId}`
                });
                console.log(`  ├─ Rebuilt role '${roleName}' → agent '${agent.agentName}'`);
            }
        } catch (error) {
            console.error(`⚠️ Role map rebuild failed for agent ${agent.agentId}: ${error.message}`);
        }
    }

    const roleList = Object.entries(roleToResourcesMap).map(([role, resources]) =>
        `${role}: ${resources.map(r => `${r.agentName}(${r.type})`).join(', ')}`
    );
    console.log(`✅ Role map rebuilt: ${Object.keys(roleToResourcesMap).length} role(s) mapped`);
    console.log(`📋 Role map:\n${roleList.map(r => `  ├─ ${r}`).join('\n')}`);
}

module.exports = {
    rebuildRoleMapFromDiscoveredAgents, discoverAllNewAgents, createStandardMessage,
    fetchAgentName, findResourceByArn
};
