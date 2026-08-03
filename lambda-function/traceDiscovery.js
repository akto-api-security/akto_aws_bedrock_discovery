/**
 * AgentCore Harness/Runtime discovery, plus tag and IAM-role enrichment for
 * discovery messages and conversation messages. Owns the per-invocation
 * in-memory caches that avoid repeat API calls for the same resource.
 *
 * Separate from discovery.js (Bedrock Agent Classic, S3 logs) — Harness/Runtime
 * conversation data comes from CloudWatch traces instead (see logGroupReader.js/
 * traceParser.js), so this pipeline is wired up independently in index.js.
 */
const { ListHarnessesCommand, GetHarnessCommand, ListAgentRuntimesCommand, GetAgentRuntimeCommand, ListTagsForResourceCommand: BedrockCoreListTagsCommand } = require('@aws-sdk/client-bedrock-agentcore-control');
const { ListAttachedRolePoliciesCommand } = require('@aws-sdk/client-iam');
const { AWS_REGION, AWS_ACCOUNT_ID, TIME_SAFETY_MARGIN_MS, bedrockAgentCoreControlClient, iamClient } = require('./config');
const { buildAgentMessage } = require('./traceMessageBuilder');

const harnessNameCache = {};       // role suffix -> harness name
const harnessIdCache = {};         // role suffix -> harness ID
const harnessExecutionRoleCache = {}; // role suffix -> execution role ARN
const tagsCache = {};

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

/** Lists every AgentCore harness in the account. Returns [] (not a throw) on failure. */
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
 * Lists every AgentCore Runtime in the account. A Runtime is a separate
 * resource from Harness — a Harness provisions one under the hood, but
 * Runtimes can also be created standalone, invisible to ListHarnesses.
 * Returns [] (not a throw) on failure.
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
 * Maps each harness's execution-role suffix (e.g. "fr53w") to its name/ID/role
 * ARN. Log entries only carry the role suffix, not the harness name, so this
 * cache is what resolves a human-readable bot name.
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

/** Generic cached tag-fetch wrapper — every AKTO tag lookup follows this shape. */
async function fetchTagsCached(cacheKey, fetcher) {
    if (tagsCache[cacheKey]) return tagsCache[cacheKey];
    const tags = await fetcher();
    tagsCache[cacheKey] = tags;
    return tags;
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

/** Adds a harness's execution role ARN + its attached policy names to a tag set. */
async function addHarnessRoleAndPermissions(tags, executionRoleArn) {
    return addExecutionRoleAndPermissions(tags, executionRoleArn, 'harness');
}

/** Adds a Runtime's execution role ARN + its attached policy names to a tag set. */
async function addRuntimeRoleAndPermissions(tags, executionRoleArn) {
    return addExecutionRoleAndPermissions(tags, executionRoleArn, 'runtime');
}

/** Shared implementation behind addHarnessRoleAndPermissions/addRuntimeRoleAndPermissions — prefix picks the tag key names. */
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

/** Lists a role's attached managed policy names, cached per role for the invocation. */
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

/** Pulls the model ID out of a Harness's model config — a provider union type (bedrock/openAi/gemini/liteLlm), each keyed by modelId. */
function extractHarnessModelId(model) {
    if (!model) return '';
    return model.bedrockModelConfig?.modelId || model.openAiModelConfig?.modelId
        || model.geminiModelConfig?.modelId || model.liteLlmModelConfig?.modelId || '';
}

/** Looks up a harness's name from its execution-role suffix (populated by initializeHarnessCache). */
function getHarnessName(roleSuffix) { return roleSuffix ? (harnessNameCache[roleSuffix] || '') : ''; }
/** Looks up a harness's ID from its execution-role suffix. */
function getHarnessId(roleSuffix) { return roleSuffix ? (harnessIdCache[roleSuffix] || '') : ''; }
/** Looks up a harness's execution role ARN from its role suffix. */
function getHarnessExecutionRoleArn(roleSuffix) { return roleSuffix ? (harnessExecutionRoleCache[roleSuffix] || '') : ''; }

/** Builds one AKTO message from a conversation pair: resolves the bot name, fetches and enriches tags, then hands off to buildAgentMessage. */
async function createStandardMessage(pair) {
    pair.botName = pair.resourceName || (pair.logType === 'HARNESS' ? getHarnessName(pair.harnessRoleSuffix) : '');

    let harnessTags = {};
    let runtimeTags = {};
    let awsMetadata = {};

    if (pair.logType === 'HARNESS' && pair.harnessId) {
        harnessTags = await fetchTagsCached(`harness-${pair.harnessId}`, () => getHarnessTags(pair.harnessId));
        harnessTags = await addHarnessRoleAndPermissions(harnessTags, getHarnessExecutionRoleArn(pair.harnessRoleSuffix) || pair.executionRoleArn);
        const toolsAndSkills = await getHarnessToolsAndSkills(pair.harnessId);
        harnessTags = { ...harnessTags, ...toolsAndSkills };
        awsMetadata = {
            'harness-configured-tools': toolsAndSkills['harness-configured-tools'] || '',
            'harness-configured-skills': toolsAndSkills['harness-configured-skills'] || '',
            model: pair.modelId,
            'harness-execution-role': harnessTags['harness-execution-role'] || '',
            traceData: pair.traceData || {}
        };
    } else if (pair.logType === 'RUNTIME' && pair.runtimeId) {
        const runtimeArn = `arn:aws:bedrock-agentcore:${AWS_REGION}:${AWS_ACCOUNT_ID}:runtime/${pair.runtimeId}`;
        runtimeTags = await fetchTagsCached(`runtime-${pair.runtimeId}`, () => getAgentRuntimeTags(runtimeArn));
        runtimeTags = await addRuntimeRoleAndPermissions(runtimeTags, pair.executionRoleArn);
        if (pair.traceData?.sessionId) runtimeTags['session-id'] = pair.traceData.sessionId;
        if (pair.traceData?.traceId) runtimeTags['trace-id'] = pair.traceData.traceId;
        awsMetadata = {
            model: pair.modelId,
            'runtime-execution-role': runtimeTags['runtime-execution-role'] || '',
            traceData: pair.traceData || {}
        };
    }

    return buildAgentMessage({ ...pair, accountId: pair.accountId || AWS_ACCOUNT_ID, region: pair.region || AWS_REGION, harnessTags, runtimeTags, awsMetadata }, true);
}

/**
 * Self-healing backfill for manifest entries discovered before executionRoleArn
 * was tracked. No-ops once every entry has the field. Mutates discoveredAgents
 * in place, same pattern as discoverNewResources.
 */
async function backfillExecutionRoleArns(discoveredAgents, timeLeft) {
    let backfilled = 0;
    for (const [key, entry] of Object.entries(discoveredAgents)) {
        if (entry.executionRoleArn) continue;
        if (timeLeft() < TIME_SAFETY_MARGIN_MS) { console.warn('⏱️ Time budget low — deferring remaining executionRoleArn backfill'); break; }
        try {
            let executionRoleArn = '';
            if (entry.resourceType === 'HARNESS') {
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
 * resource's execution role ARN, so a conversation trace can be attributed by
 * exact role identity instead of guessing from naming convention.
 */
function buildRoleNameToResourceMap(discoveredAgents) {
    const map = {};
    for (const entry of Object.values(discoveredAgents)) {
        const roleName = extractRoleNameFromArn(entry.executionRoleArn);
        if (roleName) map[roleName] = { resourceType: entry.resourceType, resourceId: entry.resourceId, resourceName: entry.resourceName, executionRoleArn: entry.executionRoleArn, foundationModel: entry.foundationModel || '' };
    }
    return map;
}

/**
 * Builds a harnessName -> resource lookup, keyed by name rather than
 * execution role (a Harness and its auto-provisioned Runtime commonly share
 * one role, so a role-keyed map can't reliably distinguish them).
 */
function buildHarnessNameToResourceMap(discoveredAgents) {
    const map = {};
    for (const entry of Object.values(discoveredAgents)) {
        if (entry.resourceType === 'HARNESS' && entry.resourceName) {
            map[entry.resourceName] = { resourceId: entry.resourceId, resourceName: entry.resourceName, executionRoleArn: entry.executionRoleArn, foundationModel: entry.foundationModel || '' };
        }
    }
    return map;
}

/**
 * Discovers harnesses/runtimes not yet in discoveredAgents (mutated in place)
 * and returns metadata-only messages for them. Bails early on low time budget —
 * anything not yet discovered is picked up on the next invocation.
 */
async function discoverNewResources(discoveredAgents, timeLeft) {
    const messages = [];

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
            const arn = metadata.arn || `arn:aws:bedrock-agentcore:${AWS_REGION}:${AWS_ACCOUNT_ID}:harness/${harness.harnessId}`;
            const foundationModel = extractHarnessModelId(metadata.model) || 'N/A';
            messages.push(buildAgentMessage({
                ...metadata, resourceType: 'HARNESS', harnessId: harness.harnessId, harnessName: harness.harnessName, arn,
                harnessTags, agentStatus: metadata.status || 'PREPARED', foundationModel
            }, false));
            discoveredAgents[key] = { resourceId: harness.harnessId, resourceType: 'HARNESS', resourceName: harness.harnessName, foundationModel, executionRoleArn: metadata.executionRoleArn || '', discoveredAt: new Date().toISOString() };
        } catch (error) {
            console.error(`⚠️ Discovery failed for harness ${harness.harnessId}: ${error.message}`);
        }
    }

    const runtimes = await listAllAgentRuntimes();
    for (const runtime of runtimes) {
        if (timeLeft() < TIME_SAFETY_MARGIN_MS) { console.warn('⏱️ Time budget low — deferring remaining runtime discovery'); return messages; }
        const key = `runtime-${runtime.agentRuntimeId}`;
        if (discoveredAgents[key]) continue;

        // A Harness's auto-provisioned runtime (named "harness_<harnessName>") is already
        // represented by that Harness's own discovery entry — skip it here.
        const harnessNameMatch = runtime.agentRuntimeName?.match(/^harness_(.+)$/);
        if (harnessNameMatch && Object.values(discoveredAgents).some((e) => e.resourceType === 'HARNESS' && e.resourceName === harnessNameMatch[1])) continue;

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
                harnessTags: {}, runtimeTags
            }, false));
            discoveredAgents[key] = { resourceId: runtime.agentRuntimeId, resourceType: 'RUNTIME', resourceName: runtime.agentRuntimeName, executionRoleArn: metadata.roleArn || '', discoveredAt: new Date().toISOString() };
        } catch (error) {
            console.error(`⚠️ Discovery failed for runtime ${runtime.agentRuntimeId}: ${error.message}`);
        }
    }

    return messages;
}

module.exports = {
    initializeHarnessCache, discoverNewResources, createStandardMessage,
    getHarnessName, getHarnessId, backfillExecutionRoleArns, buildRoleNameToResourceMap, buildHarnessNameToResourceMap,
    // Reused by gatewayDiscovery.js to map harnesses to the gateways they call.
    listAllPages, listAllHarnesses, getHarnessMetadata
};
