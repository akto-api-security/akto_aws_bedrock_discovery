/**
 * Bedrock Agent / AgentCore Harness discovery, plus tag and IAM-role enrichment
 * for both discovery messages and real conversation messages. Owns the
 * per-invocation in-memory caches that avoid repeat API calls for the same
 * resource within one Lambda run.
 */
const { GetAgentCommand, ListAgentsCommand, ListTagsForResourceCommand: BedrockAgentListTagsCommand } = require('@aws-sdk/client-bedrock-agent');
const { ListHarnessesCommand, GetHarnessCommand, ListTagsForResourceCommand: BedrockCoreListTagsCommand } = require('@aws-sdk/client-bedrock-agentcore-control');
const { ListAttachedRolePoliciesCommand } = require('@aws-sdk/client-iam');
const { AWS_REGION, AWS_ACCOUNT_ID, TIME_SAFETY_MARGIN_MS, bedrockAgentClient, bedrockAgentCoreControlClient, iamClient } = require('./config');
const { buildAgentMessage } = require('./messageBuilder');

const agentNameCache = {};
const harnessNameCache = {};       // role suffix -> harness name
const harnessIdCache = {};         // role suffix -> harness ID
const harnessExecutionRoleCache = {}; // role suffix -> execution role ARN
const tagsCache = {};

// Role-based mappings for log processing (discovery source is source of truth for type)
const roleToResourcesMap = {}; // roleName -> [{agentId, agentName, type: 'AGENT', agentArn}, ...] or [{harnessId, harnessName, type: 'HARNESS', harnessArn}, ...]

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

/** Lists every AgentCore harness in the account. Returns [] (not a throw) if the API call fails. */
async function listAllHarnesses() {
    try {
        const response = await bedrockAgentCoreControlClient.send(new ListHarnessesCommand({}));
        return response.harnesses || [];
    } catch (error) {
        console.error(`❌ ListHarnesses failed: ${error.message}`);
        return [];
    }
}

/** Fetches full metadata for one harness. Returns null on failure. */
async function getHarnessMetadata(harnessId) {
    try {
        return (await bedrockAgentCoreControlClient.send(new GetHarnessCommand({ harnessId }))).harness;
    } catch (error) {
        console.error(`❌ GetHarness failed for ${harnessId}: ${error.message}`);
        return null;
    }
}

/**
 * Populates harnessNameCache/harnessIdCache/harnessExecutionRoleCache by mapping
 * each harness's execution-role suffix (e.g. "fr53w") to its name/ID/role ARN.
 * Log entries only carry the role suffix, not the harness name, so this cache is
 * what lets processBedrockLogEntry resolve a human-readable bot name.
 */
async function initializeHarnessCache() {
    try {
        const harnesses = (await bedrockAgentCoreControlClient.send(new ListHarnessesCommand({}))).harnesses || [];
        for (const item of harnesses) {
            if (!item.harnessId || !item.harnessName) continue;
            try {
                const details = (await bedrockAgentCoreControlClient.send(new GetHarnessCommand({ harnessId: item.harnessId }))).harness;
                const roleMatch = details?.executionRoleArn?.match(/AmazonBedrockAgentCoreHarnessDefaultServiceRole-([a-z0-9]+)/);
                if (roleMatch) {
                    const suffix = roleMatch[1];
                    harnessNameCache[suffix] = item.harnessName;
                    harnessIdCache[suffix] = details.harnessId;
                    harnessExecutionRoleCache[suffix] = details.executionRoleArn;
                }
            } catch (error) {
                console.error(`❌ GetHarness failed during cache init for ${item.harnessId}: ${error.message}`);
            }
        }
        console.log(`✅ Harness cache initialized: ${Object.keys(harnessNameCache).length} mapping(s)`);
    } catch (error) {
        console.error(`❌ Harness cache init failed (will use raw identifiers instead of names): ${error.message}`);
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

/** Fetches AWS resource tags for one AgentCore harness. */
async function getHarnessTags(harnessId) {
    try {
        const arn = `arn:aws:bedrock-agentcore:${AWS_REGION}:${AWS_ACCOUNT_ID}:harness/${harnessId}`;
        return (await bedrockAgentCoreControlClient.send(new BedrockCoreListTagsCommand({ resourceArn: arn }))).tags || {};
    } catch (error) {
        console.error(`⚠️ Tag fetch failed for harness ${harnessId}: ${error.message}`);
        return {};
    }
}

/** Adds the agent's execution role ARN + its attached policy names to a tag set. */
async function addAgentRoleAndPermissions(tags, agentId) {
    try {
        const agentDetails = await bedrockAgentClient.send(new GetAgentCommand({ agentId }));
        const roleArn = agentDetails.agent?.agentRoleArn || agentDetails.agent?.executionRoleArn || '';
        if (!roleArn) return tags;
        const roleName = extractRoleNameFromArn(roleArn);
        return { ...tags, 'bedrock-execution-role-arn': roleArn, 'bedrock-execution-role': roleName, 'bedrock-role-policies': await getRolePolicies(roleName) };
    } catch (error) {
        console.error(`⚠️ Role lookup failed for agent ${agentId}: ${error.message}`);
        return tags;
    }
}

/** Adds a harness's execution role ARN + its attached policy names to a tag set. */
async function addHarnessRoleAndPermissions(tags, executionRoleArn) {
    if (!executionRoleArn) return tags;
    try {
        const roleName = extractRoleNameFromArn(executionRoleArn);
        return { ...tags, 'harness-execution-role-arn': executionRoleArn, 'harness-execution-role': roleName, 'harness-role-policies': await getRolePolicies(roleName) };
    } catch (error) {
        console.error(`⚠️ Role lookup failed for role ${executionRoleArn}: ${error.message}`);
        return tags;
    }
}

/** Reads a harness's configured tools/skills and formats them as tag values. */
async function getHarnessToolsAndSkills(harnessId) {
    try {
        const details = (await bedrockAgentCoreControlClient.send(new GetHarnessCommand({ harnessId }))).harness;
        const tags = {};
        const tools = details?.tools || [];
        if (tools.length > 0) {
            tags['harness-configured-tools'] = tools.map((t) => `${t.toolName || t.name || t.toolSpec?.name || 'unknown'}:${t.type || t.toolSpec?.type || 'unknown'}`).join(',');
        }
        const skills = details?.skills || [];
        if (skills.length > 0) {
            tags['harness-configured-skills'] = skills.flatMap((skill) => Object.keys(skill).map((type) => {
                const config = skill[type];
                const source = (config && typeof config === 'object') ? (config.url || config.source || config.sourceType || JSON.stringify(config).slice(0, 50)) : 'default';
                return `${type}:${source}`;
            })).join(',');
        }
        return tags;
    } catch (error) {
        console.error(`⚠️ Tools/skills fetch failed for harness ${harnessId}: ${error.message}`);
        return {};
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

/** Looks up a harness's name from its execution-role suffix (populated by initializeHarnessCache). */
function getHarnessName(roleSuffix) { return roleSuffix ? (harnessNameCache[roleSuffix] || '') : ''; }
/** Looks up a harness's ID from its execution-role suffix. */
function getHarnessId(roleSuffix) { return roleSuffix ? (harnessIdCache[roleSuffix] || '') : ''; }
/** Looks up a harness's execution role ARN from its role suffix. */
function getHarnessExecutionRoleArn(roleSuffix) { return roleSuffix ? (harnessExecutionRoleCache[roleSuffix] || '') : ''; }

/**
 * Builds one AKTO message from a real conversation pair: resolves the bot name,
 * fetches and enriches agent/harness tags, then hands everything to buildAgentMessage.
 */
async function createStandardMessage(pair) {
    pair.botName = pair.logType === 'AGENT'
        ? await fetchAgentName(pair.agentId)
        : (pair.logType === 'HARNESS' ? getHarnessName(pair.harnessRoleSuffix) : '');

    let agentTags = {};
    let harnessTags = {};
    let awsMetadata = {};

    if (pair.logType === 'AGENT' && pair.agentId) {
        agentTags = await fetchTagsCached(`agent-${pair.agentId}`, () => getBedrockAgentTags(pair.agentId));
        agentTags = await addAgentRoleAndPermissions(agentTags, pair.agentId);
    } else if (pair.logType === 'HARNESS' && pair.harnessId) {
        harnessTags = await fetchTagsCached(`harness-${pair.harnessId}`, () => getHarnessTags(pair.harnessId));
        harnessTags = await addHarnessRoleAndPermissions(harnessTags, getHarnessExecutionRoleArn(pair.harnessRoleSuffix));
        const toolsAndSkills = await getHarnessToolsAndSkills(pair.harnessId);
        harnessTags = { ...harnessTags, ...toolsAndSkills };
        awsMetadata = {
            'harness-configured-tools': toolsAndSkills['harness-configured-tools'] || '',
            'harness-configured-skills': toolsAndSkills['harness-configured-skills'] || '',
            model: pair.modelId,
            'harness-execution-role': harnessTags['harness-execution-role'] || '',
            traceData: pair.traceData || {}
        };
    }

    return buildAgentMessage({ ...pair, accountId: pair.accountId || AWS_ACCOUNT_ID, region: pair.region || AWS_REGION, agentTags, harnessTags, awsMetadata }, true);
}

/**
 * Discovers agents/harnesses not yet in `discoveredAgents` (mutated in place) and
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
                    console.log(`✅ Mapped agent role '${roleName}' → agent '${agent.agentName}'`);
                }
            }
        } catch (error) {
            console.error(`⚠️ Discovery failed for agent ${agent.agentId}: ${error.message}`);
        }
    }

    const harnesses = await listAllHarnesses();
    for (const harness of harnesses) {
        if (timeLeft() < TIME_SAFETY_MARGIN_MS) { console.warn('⏱️ Time budget low — deferring remaining harness discovery'); return messages; }
        const key = `harness-${harness.harnessId}`;
        if (discoveredAgents[key]) continue;
        try {
            const metadata = await getHarnessMetadata(harness.harnessId);
            if (!metadata) continue;
            let harnessTags = await fetchTagsCached(`harness-${harness.harnessId}`, () => getHarnessTags(harness.harnessId));
            if (metadata.executionRoleArn) harnessTags = await addHarnessRoleAndPermissions(harnessTags, metadata.executionRoleArn);
            const arn = metadata.harnessArn || `arn:aws:bedrock-agentcore:${AWS_REGION}:${AWS_ACCOUNT_ID}:harness/${harness.harnessId}`;
            messages.push(buildAgentMessage({
                ...metadata, resourceType: 'HARNESS', harnessId: harness.harnessId, harnessName: harness.harnessName, arn,
                agentTags: {}, harnessTags, agentStatus: metadata.harnessStatus || 'PREPARED', foundationModel: metadata.foundationModel || 'N/A'
            }, false));
            discoveredAgents[key] = { resourceId: harness.harnessId, resourceType: 'HARNESS', resourceName: harness.harnessName, foundationModel: metadata.foundationModel || 'N/A', discoveredAt: new Date().toISOString() };

            // Build role mapping for log processing
            if (metadata.executionRoleArn) {
                const roleName = extractRoleNameFromArn(metadata.executionRoleArn);
                if (roleName) {
                    if (!roleToResourcesMap[roleName]) roleToResourcesMap[roleName] = [];
                    roleToResourcesMap[roleName].push({
                        harnessId: harness.harnessId,
                        harnessName: harness.harnessName,
                        type: 'HARNESS',
                        harnessArn: arn
                    });
                    console.log(`✅ Mapped harness role '${roleName}' → harness '${harness.harnessName}'`);
                }
            }
        } catch (error) {
            console.error(`⚠️ Discovery failed for harness ${harness.harnessId}: ${error.message}`);
        }
    }

    return messages;
}

/**
 * Finds a resource (agent or harness) from a log STS ARN by:
 * 1. Trying to extract agent ID from session name (if present)
 * 2. Trying to extract harness suffix from role name (if present)
 * 3. Looking up by role name in the map
 * Returns null if not found or ambiguous (multiple resources on same role without determinable ID).
 */
function findResourceByArn(stsArn) {
    if (!stsArn) return null;

    // Extract role name from STS ARN
    const roleNameMatch = stsArn.match(/assumed-role\/([^\/]+)/);
    if (!roleNameMatch) return null;
    const roleName = roleNameMatch[1];

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

        // Try to extract harness suffix from role name
        const harnessMatch = sessionName.match(/^BedrockAgentCore-/);
        if (harnessMatch) {
            const suffixMatch = roleName.match(/AmazonBedrockAgentCoreHarnessDefaultServiceRole-([a-z0-9]+)/);
            if (suffixMatch) {
                const suffix = suffixMatch[1];
                const resources = roleToResourcesMap[roleName];
                if (resources && resources.length === 1 && resources[0].type === 'HARNESS') {
                    console.log(`✅ Found harness by suffix: ${resources[0].harnessName}`);
                    return resources[0];
                }
            }
        }
    }

    // Look up by role name
    const resources = roleToResourcesMap[roleName];

    // No resources found
    if (!resources) {
        console.warn(`⚠️ Unknown role: ${roleName}. Skipping log entry.`);
        return null;
    }

    // Exactly one resource on this role
    if (resources.length === 1) {
        console.log(`✅ Found resource by role name: ${resources[0].agentName || resources[0].harnessName}`);
        return resources[0];
    }

    // Multiple resources on same role - cannot determine which one
    console.warn(
        `⚠️ Role '${roleName}' maps to ${resources.length} resources (${resources.map(r => r.agentName || r.harnessName).join(', ')}). ` +
        `Cannot determine correct mapping from session name. Skipping log entry.`
    );
    return null;
}

module.exports = {
    initializeHarnessCache, discoverAllNewAgents, createStandardMessage,
    fetchAgentName, getHarnessName, findResourceByArn
};
