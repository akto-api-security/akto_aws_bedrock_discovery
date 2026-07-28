/**
 * Bedrock Agent / AgentCore Harness discovery, plus tag and IAM-role enrichment
 * for both discovery messages and real conversation messages. Owns the
 * per-invocation in-memory caches that avoid repeat API calls for the same
 * resource within one Lambda run.
 */
const { GetAgentCommand, ListAgentsCommand, ListTagsForResourceCommand: BedrockAgentListTagsCommand } = require('@aws-sdk/client-bedrock-agent');
const { ListHarnessesCommand, GetHarnessCommand, ListAgentRuntimesCommand, GetAgentRuntimeCommand, ListTagsForResourceCommand: BedrockCoreListTagsCommand } = require('@aws-sdk/client-bedrock-agentcore-control');
const { ListAttachedRolePoliciesCommand } = require('@aws-sdk/client-iam');
const { AWS_REGION, AWS_ACCOUNT_ID, TIME_SAFETY_MARGIN_MS, bedrockAgentClient, bedrockAgentCoreControlClient, iamClient } = require('./config');
const { buildAgentMessage } = require('./messageBuilder');

const agentNameCache = {};
const harnessNameCache = {};       // role suffix -> harness name
const harnessIdCache = {};         // role suffix -> harness ID
const harnessExecutionRoleCache = {}; // role suffix -> execution role ARN
const tagsCache = {};

/**
 * Generic pager: calls `sendPage(nextToken)` repeatedly until no nextToken comes
 * back, concatenating whatever `pluck(response)` returns from each page.
 */
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

/** Lists every Bedrock Agent in the account, across all pages. Returns [] (not a throw) if the API call fails. */
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

/** Lists every AgentCore harness in the account, across all pages. Returns [] (not a throw) if the API call fails. */
async function listAllHarnesses() {
    try {
        return await listAllPages(
            (nextToken) => bedrockAgentCoreControlClient.send(new ListHarnessesCommand({ nextToken })),
            (response) => response.harnesses
        );
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
 * Lists every AgentCore Runtime in the account, across all pages. A Runtime is
 * a separate resource from Harness — creating a Harness provisions one under
 * the hood, but Runtimes can also be created standalone, bypassing Harness
 * entirely. Those standalone ones are invisible to ListHarnesses, hence this
 * separate listing. Returns [] (not a throw) if the API call fails.
 */
async function listAllAgentRuntimes() {
    try {
        return await listAllPages(
            (nextToken) => bedrockAgentCoreControlClient.send(new ListAgentRuntimesCommand({ nextToken })),
            (response) => response.agentRuntimes
        );
    } catch (error) {
        console.error(`❌ ListAgentRuntimes failed: ${error.message}`);
        return [];
    }
}

/** Fetches full metadata for one AgentCore Runtime. Returns null on failure. */
async function getAgentRuntimeMetadata(agentRuntimeId) {
    try {
        return await bedrockAgentCoreControlClient.send(new GetAgentRuntimeCommand({ agentRuntimeId }));
    } catch (error) {
        console.error(`❌ GetAgentRuntime failed for ${agentRuntimeId}: ${error.message}`);
        return null;
    }
}

/** Fetches AWS resource tags for one AgentCore Runtime. */
async function getAgentRuntimeTags(agentRuntimeArn) {
    try {
        return (await bedrockAgentCoreControlClient.send(new BedrockCoreListTagsCommand({ resourceArn: agentRuntimeArn }))).tags || {};
    } catch (error) {
        console.error(`⚠️ Tag fetch failed for runtime ${agentRuntimeArn}: ${error.message}`);
        return {};
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
        const harnesses = await listAllHarnesses();
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

/**
 * Adds the agent's execution role ARN + its attached policy names to a tag set.
 * Takes the agent's already-fetched metadata (from GetAgent) rather than an
 * agentId, so callers that already have it don't trigger a second, redundant
 * GetAgent call — with 30+ agents in an account, that redundancy roughly
 * doubled discovery's AWS API call volume and made throttling-induced silent
 * skips more likely.
 */
async function addAgentRoleAndPermissions(tags, agentMetadata) {
    const roleArn = agentMetadata?.agentRoleArn || agentMetadata?.executionRoleArn || '';
    return addExecutionRoleAndPermissions(tags, roleArn, 'bedrock');
}

/** Adds a harness's execution role ARN + its attached policy names to a tag set. */
async function addHarnessRoleAndPermissions(tags, executionRoleArn) {
    return addExecutionRoleAndPermissions(tags, executionRoleArn, 'harness');
}

/** Adds a Runtime's execution role ARN + its attached policy names to a tag set. */
async function addRuntimeRoleAndPermissions(tags, executionRoleArn) {
    return addExecutionRoleAndPermissions(tags, executionRoleArn, 'runtime');
}

/** Shared implementation behind addHarnessRoleAndPermissions/addRuntimeRoleAndPermissions — `prefix` picks the tag key names. */
async function addExecutionRoleAndPermissions(tags, executionRoleArn, prefix) {
    if (!executionRoleArn) return tags;
    try {
        const roleName = extractRoleNameFromArn(executionRoleArn);
        return { ...tags, [`${prefix}-execution-role-arn`]: executionRoleArn, [`${prefix}-execution-role`]: roleName, [`${prefix}-role-policies`]: await getRolePolicies(roleName) };
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
    // resourceName arrives already resolved when roleNameToResourceMap matched
    // (see extractors.js resolveLogIdentity) — the per-type lookups below are
    // only needed as a fallback for entries the map doesn't cover yet.
    pair.botName = pair.resourceName || (pair.logType === 'AGENT'
        ? await fetchAgentName(pair.agentId)
        : (pair.logType === 'HARNESS' ? getHarnessName(pair.harnessRoleSuffix) : ''));

    let agentTags = {};
    let harnessTags = {};
    let runtimeTags = {};
    let awsMetadata = {};

    if (pair.logType === 'AGENT' && pair.agentId) {
        agentTags = await fetchTagsCached(`agent-${pair.agentId}`, () => getBedrockAgentTags(pair.agentId));
        agentTags = await addAgentRoleAndPermissions(agentTags, await getAgentMetadata(pair.agentId));
    } else if (pair.logType === 'HARNESS' && pair.harnessId) {
        harnessTags = await fetchTagsCached(`harness-${pair.harnessId}`, () => getHarnessTags(pair.harnessId));
        harnessTags = await addHarnessRoleAndPermissions(harnessTags, getHarnessExecutionRoleArn(pair.harnessRoleSuffix) || pair.executionRoleArn);
        const toolsAndSkills = await getHarnessToolsAndSkills(pair.harnessId);
        harnessTags = { ...harnessTags, ...toolsAndSkills };
        awsMetadata = {
            'harness-configured-tools': toolsAndSkills['harness-configured-tools'] || '',
            'harness-configured-skills': toolsAndSkills['harness-configured-skills'] || '',
            model: pair.modelId,
            'harness-execution-role': harnessTags['harness-execution-role'] || '',
            'bedrock-execution-role': harnessTags['bedrock-execution-role'] || '',
            traceData: pair.traceData || {}
        };
    } else if (pair.logType === 'RUNTIME' && pair.runtimeId) {
        // Only ever reachable via a roleNameToResourceMap match — there's no
        // naming-convention regex for standalone Runtime execution roles, so
        // this branch depends entirely on the map (and thus on the resource's
        // executionRoleArn already being known/backfilled).
        const runtimeArn = `arn:aws:bedrock-agentcore:${AWS_REGION}:${AWS_ACCOUNT_ID}:runtime/${pair.runtimeId}`;
        runtimeTags = await fetchTagsCached(`runtime-${pair.runtimeId}`, () => getAgentRuntimeTags(runtimeArn));
        runtimeTags = await addRuntimeRoleAndPermissions(runtimeTags, pair.executionRoleArn);
        awsMetadata = {
            model: pair.modelId,
            'runtime-execution-role': runtimeTags['runtime-execution-role'] || '',
            traceData: pair.traceData || {}
        };
    }

    return buildAgentMessage({ ...pair, accountId: pair.accountId || AWS_ACCOUNT_ID, region: pair.region || AWS_REGION, agentTags, harnessTags, runtimeTags, awsMetadata }, true);
}

/**
 * Self-healing backfill for manifest entries discovered before executionRoleArn
 * was tracked (or when a fetch failed the first time) — re-fetches just enough
 * metadata to fill the gap so buildRoleNameToResourceMap can cover them too.
 * Naturally a no-op once every entry already has the field. Mutates
 * discoveredAgents in place, same pattern as discoverAllNewAgents.
 */
async function backfillExecutionRoleArns(discoveredAgents, timeLeft) {
    let backfilled = 0;
    for (const [key, entry] of Object.entries(discoveredAgents)) {
        if (entry.executionRoleArn) continue;
        if (timeLeft() < TIME_SAFETY_MARGIN_MS) { console.warn('⏱️ Time budget low — deferring remaining executionRoleArn backfill'); break; }
        try {
            let executionRoleArn = '';
            if (entry.resourceType === 'AGENT') {
                const metadata = await getAgentMetadata(entry.resourceId);
                executionRoleArn = metadata?.agentRoleArn || metadata?.executionRoleArn || '';
            } else if (entry.resourceType === 'HARNESS') {
                executionRoleArn = (await getHarnessMetadata(entry.resourceId))?.executionRoleArn || '';
            } else if (entry.resourceType === 'RUNTIME') {
                executionRoleArn = (await getAgentRuntimeMetadata(entry.resourceId))?.roleArn || '';
            }
            if (executionRoleArn) {
                entry.executionRoleArn = executionRoleArn;
                backfilled++;
            }
        } catch (error) {
            console.error(`⚠️ executionRoleArn backfill failed for ${key}: ${error.message}`);
        }
    }
    if (backfilled > 0) console.log(`✅ Backfilled executionRoleArn for ${backfilled} pre-existing resource(s)`);
    return discoveredAgents;
}

/**
 * Builds an authoritative roleName -> resource lookup from every discovered
 * resource's real execution role ARN. This is what lets a conversation log
 * entry be attributed by exact role identity instead of guessing from the
 * role's naming convention — the guess breaks the moment a customer uses a
 * custom-named execution role instead of AWS's auto-generated default one.
 */
function buildRoleNameToResourceMap(discoveredAgents) {
    const map = {};
    for (const entry of Object.values(discoveredAgents)) {
        const roleName = extractRoleNameFromArn(entry.executionRoleArn);
        if (roleName) map[roleName] = { resourceType: entry.resourceType, resourceId: entry.resourceId, resourceName: entry.resourceName, executionRoleArn: entry.executionRoleArn };
    }
    return map;
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
            agentTags = await addAgentRoleAndPermissions(agentTags, metadata);
            const arn = metadata.agentArn || `arn:aws:bedrock:${AWS_REGION}:${AWS_ACCOUNT_ID}:agent/${agent.agentId}`;
            const executionRoleArn = metadata.agentRoleArn || metadata.executionRoleArn || '';
            messages.push(buildAgentMessage({ ...metadata, resourceType: 'AGENT', arn, agentTags, harnessTags: {} }, false));
            discoveredAgents[key] = { resourceId: agent.agentId, resourceType: 'AGENT', resourceName: agent.agentName, foundationModel: metadata.foundationModel, executionRoleArn, discoveredAt: new Date().toISOString() };
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
            discoveredAgents[key] = { resourceId: harness.harnessId, resourceType: 'HARNESS', resourceName: harness.harnessName, foundationModel: metadata.foundationModel || 'N/A', executionRoleArn: metadata.executionRoleArn || '', discoveredAt: new Date().toISOString() };
        } catch (error) {
            console.error(`⚠️ Discovery failed for harness ${harness.harnessId}: ${error.message}`);
        }
    }

    const runtimes = await listAllAgentRuntimes();
    for (const runtime of runtimes) {
        if (timeLeft() < TIME_SAFETY_MARGIN_MS) { console.warn('⏱️ Time budget low — deferring remaining runtime discovery'); return messages; }
        const key = `runtime-${runtime.agentRuntimeId}`;
        if (discoveredAgents[key]) continue;
        try {
            const metadata = await getAgentRuntimeMetadata(runtime.agentRuntimeId);
            if (!metadata) continue;
            const arn = metadata.agentRuntimeArn || `arn:aws:bedrock-agentcore:${AWS_REGION}:${AWS_ACCOUNT_ID}:runtime/${runtime.agentRuntimeId}`;
            let runtimeTags = await fetchTagsCached(`runtime-${runtime.agentRuntimeId}`, () => getAgentRuntimeTags(arn));
            runtimeTags = await addRuntimeRoleAndPermissions(runtimeTags, metadata.roleArn);
            messages.push(buildAgentMessage({
                resourceType: 'RUNTIME', runtimeId: runtime.agentRuntimeId, runtimeName: runtime.agentRuntimeName, arn,
                description: metadata.description, executionRoleArn: metadata.roleArn,
                agentStatus: metadata.status || 'UNKNOWN', createdAt: metadata.createdAt, updatedAt: metadata.lastUpdatedAt,
                agentTags: {}, harnessTags: {}, runtimeTags
            }, false));
            discoveredAgents[key] = { resourceId: runtime.agentRuntimeId, resourceType: 'RUNTIME', resourceName: runtime.agentRuntimeName, executionRoleArn: metadata.roleArn || '', discoveredAt: new Date().toISOString() };
        } catch (error) {
            console.error(`⚠️ Discovery failed for runtime ${runtime.agentRuntimeId}: ${error.message}`);
        }
    }

    return messages;
}

module.exports = {
    initializeHarnessCache, discoverAllNewAgents, createStandardMessage,
    fetchAgentName, getHarnessName, getHarnessId, backfillExecutionRoleArns, buildRoleNameToResourceMap
};
