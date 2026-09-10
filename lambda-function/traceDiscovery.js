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
const { getRoleSecurityProfile } = require('./iamPermissions');
const config = require('./config');
const { AWS_REGION, AWS_ACCOUNT_ID, TIME_SAFETY_MARGIN_MS } = config;
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
            (nextToken) => config.bedrockAgentCoreControlClient.send(new ListHarnessesCommand({ nextToken })),
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
        return (await config.bedrockAgentCoreControlClient.send(new GetHarnessCommand({ harnessId }))).harness;
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
            (nextToken) => config.bedrockAgentCoreControlClient.send(new ListAgentRuntimesCommand({ nextToken })),
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
        return await config.bedrockAgentCoreControlClient.send(new GetAgentRuntimeCommand({ agentRuntimeId }));
    } catch (error) {
        console.error(`❌ GetAgentRuntime failed for ${agentRuntimeId}: ${error.message}`);
        return null;
    }
}

/** Fetches AWS resource tags for one AgentCore Runtime. */
async function getAgentRuntimeTags(agentRuntimeArn) {
    try {
        return (await config.bedrockAgentCoreControlClient.send(new BedrockCoreListTagsCommand({ resourceArn: agentRuntimeArn }))).tags || {};
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
                const details = (await config.bedrockAgentCoreControlClient.send(new GetHarnessCommand({ harnessId: item.harnessId }))).harness;
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
        return (await config.bedrockAgentCoreControlClient.send(new BedrockCoreListTagsCommand({ resourceArn: arn }))).tags || {};
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
        return {
            ...tags,
            [`${prefix}-execution-role-arn`]: executionRoleArn,
            [`${prefix}-execution-role`]: roleName,
            // Policy names alone say which policies are attached, never what they
            // permit. The security profile reads the documents behind them plus the
            // inline policies, trust policy and permissions boundary.
            ...await getRoleSecurityProfile(executionRoleArn, prefix)
        };
    } catch (error) {
        console.error(`⚠️ Role lookup failed for role ${executionRoleArn}: ${error.message}`);
        return tags;
    }
}


/**
 * Security summary of every AgentCore Gateway a harness is wired to.
 *
 * The harness's own role says what the harness may do; it says nothing about
 * where its tool calls actually land. That lives on the gateway: the backend
 * MCP endpoints, whether those backends are authenticated at all, which Lambda
 * intercepts the traffic, and what the gateway's own execution role may reach.
 * Without this, a tool call is a name with no destination.
 *
 * gatewayDiscovery is required lazily: it imports this module, so a top-level
 * require would close a cycle and hand it a half-built exports object.
 */
async function summarizeHarnessGateways(gatewayArns) {
    if (!gatewayArns.length) return {};
    // eslint-disable-next-line global-require
    const { getGatewayDetail, listGatewayTargets, getGatewayTargetDetail, readAttachedInterceptors, extractGatewayIdFromArn } = require('./gatewayDiscovery');

    const ids = [];
    const urls = [];
    const authTypes = new Set();
    const endpoints = [];
    const targetAuth = [];
    const interceptors = new Set();
    const points = new Set();
    let roleProfile = {};
    let roleArn = '';

    for (const gatewayArn of gatewayArns) {
        const gatewayId = extractGatewayIdFromArn(gatewayArn);
        if (!gatewayId) continue;
        ids.push(gatewayId);
        try {
            const gateway = await getGatewayDetail(gatewayId);
            if (!gateway) continue;
            if (gateway.gatewayUrl) urls.push(gateway.gatewayUrl);
            if (gateway.authorizerType) authTypes.add(gateway.authorizerType);
            const attached = readAttachedInterceptors(gateway);
            for (const arn of attached.arns) interceptors.add(arn);
            for (const point of attached.points) points.add(point);
            // One profile is enough: a harness almost always has a single gateway,
            // and repeating 19 fields per gateway would swamp the tag set.
            if (!roleArn && gateway.roleArn) {
                roleArn = gateway.roleArn;
                roleProfile = await getRoleSecurityProfile(gateway.roleArn, 'gateway');
            }

            for (const target of await listGatewayTargets(gatewayId)) {
                const detail = await getGatewayTargetDetail(gatewayId, target.targetId);
                const mcp = detail?.targetConfiguration?.mcp || {};
                const endpoint = mcp?.mcpServer?.endpoint || mcp?.lambda?.arn || mcp?.openApiSchema?.s3?.uri || '';
                const name = detail?.name || target.name || target.targetId;
                if (endpoint) endpoints.push(`${name}=${endpoint}`);
                // An empty credential-provider list means the gateway reaches this
                // backend unauthenticated — worth stating outright, not by omission.
                const providers = (detail?.credentialProviderConfigurations || [])
                    .map((c) => c.credentialProviderType).filter(Boolean).join('|');
                targetAuth.push(`${name}=${providers || 'none'}`);
            }
        } catch (error) {
            console.error(`⚠️ Gateway summary failed for ${gatewayArn}: ${error.message}`);
        }
    }

    return {
        'gateway-ids': ids.join(','),
        'gateway-urls': urls.join(','),
        'gateway-auth-type': [...authTypes].sort().join(','),
        'gateway-execution-role-arn': roleArn,
        'gateway-execution-role': roleArn ? roleArn.split('/').pop() : '',
        'gateway-target-endpoints': endpoints.join(','),
        'gateway-target-auth': targetAuth.join(','),
        'gateway-target-count': String(targetAuth.length),
        'gateway-unauthenticated-targets': String(targetAuth.filter((t) => t.endsWith('=none')).length),
        'gateway-interceptor-lambdas': [...interceptors].join(','),
        'gateway-interception-points': [...points].sort().join(','),
        ...roleProfile
    };
}

/** Reads a harness's configured tools/skills and formats them as tag values. */
async function getHarnessToolsAndSkills(harnessId) {
    try {
        const details = (await config.bedrockAgentCoreControlClient.send(new GetHarnessCommand({ harnessId }))).harness;
        const tags = {};
        const tools = details?.tools || [];
        if (tools.length > 0) {
            tags['harness-configured-tools'] = tools.map((t) => `${t.toolName || t.name || t.toolSpec?.name || 'unknown'}:${t.type || t.toolSpec?.type || 'unknown'}`).join(',');
        }
        // Which gateways this harness may call — the door its tool calls go through.
        const gatewayArns = tools
            .filter((t) => t.type === 'agentcore_gateway')
            .map((t) => t.config?.agentCoreGateway?.gatewayArn)
            .filter(Boolean);
        Object.assign(tags, await summarizeHarnessGateways(gatewayArns));

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


/**
 * The role/permission subset of a tag set, for mirroring into awsMetadata.
 *
 * Deliberately duplicated: `tag` is a JSON string a consumer has to parse
 * separately, so anything needed to answer "what could this agent do" is also
 * placed in the message body next to the trace it describes.
 */
function roleFields(tags, prefix) {
    const picked = {};
    for (const [key, value] of Object.entries(tags)) {
        if (key.startsWith(`${prefix}-role-`) || key === `${prefix}-permissions-boundary`) picked[key] = value;
    }
    return picked;
}

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
            'harness-execution-role-arn': harnessTags['harness-execution-role-arn'] || '',
            ...roleFields(harnessTags, 'harness'),
            traceData: pair.traceData || {}
        };
    } else if (pair.logType === 'RUNTIME' && pair.runtimeId) {
        const runtimeArn = `arn:aws:bedrock-agentcore:${AWS_REGION}:${AWS_ACCOUNT_ID}:runtime/${pair.runtimeId}`;
        runtimeTags = await fetchTagsCached(`runtime-${pair.runtimeId}`, () => getAgentRuntimeTags(runtimeArn));
        runtimeTags = await addRuntimeRoleAndPermissions(runtimeTags, pair.executionRoleArn);
        awsMetadata = {
            model: pair.modelId,
            'runtime-execution-role': runtimeTags['runtime-execution-role'] || '',
            'runtime-execution-role-arn': runtimeTags['runtime-execution-role-arn'] || '',
            ...roleFields(runtimeTags, 'runtime'),
            traceData: pair.traceData || {}
        };
    }

    // The AgentCore session is the only real conversation identifier either pipeline
    // has (Bedrock's own invocation logs carry none), so it is tagged for every log
    // type rather than only RUNTIME as it was — a Harness turn is just as much part
    // of a session as a Runtime turn, and without it multi-turn traffic cannot be
    // grouped at all.
    const traceTags = {};
    if (pair.traceData?.sessionId) traceTags['session-id'] = pair.traceData.sessionId;
    if (pair.traceData?.traceId) traceTags['trace-id'] = pair.traceData.traceId;
    if (pair.logType === 'HARNESS') Object.assign(harnessTags, traceTags);
    else if (pair.logType === 'RUNTIME') Object.assign(runtimeTags, traceTags);

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
