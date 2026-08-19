/**
 * Amazon Quick Suite agent discovery, plus the enrichment that turns a bare chat-log
 * record into a fully attributed AKTO message. The Quick counterpart of discovery.js.
 *
 * Three things are resolved here, each cached in the manifest so the steady state
 * makes no QuickSight API calls at all:
 *
 *   1. Agents — ListAgents + DescribeAgent + ListTagsForResource. Gives the real agent
 *      name for `bot-name`, exactly as the Bedrock pipeline does.
 *   2. Action connectors — ListActionConnectors + DescribeActionConnector. These are
 *      the agent's tools (Jira, ServiceNow, Slack, S3, Bedrock, generic HTTP, …), and
 *      resolving them turns an opaque id like 'quicksuite-websearch' into a name, a
 *      type and the list of actions it may perform.
 *   3. Users — DescribeUser + ListIAMPolicyAssignmentsForUser. A Quick agent has no
 *      execution role of its own; permissions attach to the asking user. For an
 *      IAM-federated user the Quick user name encodes the IAM role, so the role's
 *      attached policies are fetched through discovery.js's own getRolePolicies —
 *      literally the same call the Bedrock pipeline makes.
 */
const {
    ListAgentsCommand, DescribeAgentCommand, ListTagsForResourceCommand,
    ListActionConnectorsCommand, DescribeActionConnectorCommand,
    DescribeUserCommand, ListIAMPolicyAssignmentsForUserCommand
} = require('@aws-sdk/client-quicksight');
const {
    AWS_REGION, AWS_ACCOUNT_ID, TIME_SAFETY_MARGIN_MS, QUICK_NAMESPACE, QUICK_MODEL_ID,
    QUICK_BUILTIN_AGENT_ID, QUICK_BUILTIN_AGENT_NAME, quickSightClient
} = require('./config');
const { getRolePolicies } = require('./discovery');
const { buildQuickMessage } = require('./quickMessageBuilder');
const { buildQuickTraceData } = require('./quickParser');

/**
 * Bumped whenever the user-resolution logic changes in a way that makes previously
 * cached entries wrong. Entries in the manifest carrying an older version are
 * re-resolved instead of trusted, so a fix reaches existing deployments on the next
 * run rather than being masked forever by a stale cache.
 */
const USER_RESOLVER_VERSION = 2;

/** Per-invocation caches on top of the manifest's cross-run ones — avoids repeat work inside a single run. */
const userCache = {};
const reportedMissingAgents = new Set();

/** Generic pager for QuickSight's capitalised NextToken convention. */
async function listAllPages(sendPage, pluck) {
    let items = [];
    let nextToken;
    do {
        const response = await sendPage(nextToken);
        items = items.concat(pluck(response) || []);
        nextToken = response.NextToken;
    } while (nextToken);
    return items;
}

/** Lists every Quick agent in the account. Returns [] (not a throw) if the API call fails. */
async function listAllQuickAgents() {
    try {
        return await listAllPages(
            (NextToken) => quickSightClient.send(new ListAgentsCommand({ AwsAccountId: AWS_ACCOUNT_ID, NextToken })),
            (response) => response.AgentSummaries
        );
    } catch (error) {
        console.error(`❌ Quick ListAgents failed (check quicksight:ListAgents permission): ${error.message}`);
        return [];
    }
}

/** Full metadata for one Quick agent. Returns null on failure. */
async function getQuickAgentMetadata(agentId) {
    try {
        return (await quickSightClient.send(new DescribeAgentCommand({ AwsAccountId: AWS_ACCOUNT_ID, AgentId: agentId }))).Agent;
    } catch (error) {
        console.error(`❌ Quick DescribeAgent failed for ${agentId}: ${error.message}`);
        return null;
    }
}

/** AWS resource tags for a Quick resource, flattened from [{Key,Value}] to an object. */
async function getQuickResourceTags(resourceArn) {
    if (!resourceArn) return {};
    try {
        const response = await quickSightClient.send(new ListTagsForResourceCommand({ ResourceArn: resourceArn }));
        return Object.fromEntries((response.Tags || []).filter((t) => t?.Key).map((t) => [t.Key, t.Value || '']));
    } catch (error) {
        console.error(`⚠️ Quick tag fetch failed for ${resourceArn}: ${error.message}`);
        return {};
    }
}

/**
 * Loads every action connector in the account into the manifest-backed index.
 *
 * ListActionConnectors already returns name, type and status, so DescribeActionConnector
 * is only needed for `EnabledActions` — the list of actions a connector may actually
 * perform, which is what makes the AKTO trace show "created an issue" rather than just
 * "Jira". Connectors change rarely, so anything already in the index is left alone.
 */
async function refreshActionConnectors(actionConnectors, timeLeft) {
    let summaries = [];
    try {
        summaries = await listAllPages(
            (NextToken) => quickSightClient.send(new ListActionConnectorsCommand({ AwsAccountId: AWS_ACCOUNT_ID, NextToken })),
            (response) => response.ActionConnectorSummaries || response.ActionConnectors
        );
    } catch (error) {
        // Not fatal: without this, connectors still appear in traces under their raw id.
        console.error(`⚠️ Quick ListActionConnectors failed (check quicksight:ListActionConnectors permission): ${error.message}`);
        return 0;
    }

    let added = 0;
    for (const summary of summaries) {
        const id = summary?.ActionConnectorId;
        if (!id || actionConnectors[id]) continue;
        if (timeLeft && timeLeft() < TIME_SAFETY_MARGIN_MS) {
            console.warn('⏱️ Time budget low — deferring remaining Quick action-connector resolution');
            break;
        }
        let enabledActions = [];
        let description = '';
        try {
            const detail = (await quickSightClient.send(new DescribeActionConnectorCommand({ AwsAccountId: AWS_ACCOUNT_ID, ActionConnectorId: id }))).ActionConnector;
            enabledActions = detail?.EnabledActions || [];
            description = detail?.Description || '';
        } catch (error) {
            console.warn(`⚠️ Quick DescribeActionConnector failed for ${id}: ${error.message} — keeping summary-level detail only`);
        }
        actionConnectors[id] = {
            id,
            name: summary.Name || id,
            type: summary.Type || 'UNKNOWN',
            status: summary.Status || '',
            arn: summary.Arn || '',
            description,
            enabledActions,
            resolvedAt: new Date().toISOString()
        };
        added++;
    }
    if (added > 0) console.log(`🔌 Resolved ${added} new Quick action connector(s) — persisted, so this won't repeat`);
    return added;
}

/**
 * Resolves who asked: Quick role, identity type, and effective permissions.
 *
 * Cached by user ARN in the manifest, because a busy account has thousands of messages
 * and a handful of users — resolving per message would be two extra API calls each.
 */
async function resolveQuickUser(pair, quickUsers) {
    const { userArn, userName, namespace } = pair;
    if (!userArn || !userName) return {};
    if (userCache[userArn]) return userCache[userArn];
    if (quickUsers[userArn]?.v === USER_RESOLVER_VERSION) {
        userCache[userArn] = quickUsers[userArn];
        return quickUsers[userArn];
    }

    const resolved = { userArn, userName, v: USER_RESOLVER_VERSION };
    const ns = namespace || QUICK_NAMESPACE;

    try {
        const user = (await quickSightClient.send(new DescribeUserCommand({ AwsAccountId: AWS_ACCOUNT_ID, Namespace: ns, UserName: userName }))).User;
        if (user) {
            resolved.userRole = user.Role || '';
            resolved.identityType = user.IdentityType || '';
            resolved.userEmail = user.Email || '';
            resolved.customPermissions = user.CustomPermissionsName || '';
            resolved.principalId = user.PrincipalId || '';
        }
    } catch (error) {
        console.warn(`⚠️ Quick DescribeUser failed for '${userName}': ${error.message}`);
    }

    // The Quick analogue of "policies attached to this identity".
    try {
        const assignments = await listAllPages(
            (NextToken) => quickSightClient.send(new ListIAMPolicyAssignmentsForUserCommand({ AwsAccountId: AWS_ACCOUNT_ID, Namespace: ns, UserName: userName, NextToken })),
            (response) => response.ActiveAssignments
        );
        resolved.iamPolicies = assignments
            .map((a) => a?.PolicyArn?.split('/').pop() || a?.AssignmentName)
            .filter(Boolean)
            .join(',');
    } catch (error) {
        console.warn(`⚠️ Quick ListIAMPolicyAssignmentsForUser failed for '${userName}': ${error.message}`);
    }

    /*
     * An IAM-federated Quick user's name is '<RoleName>/<session>', so the role is
     * recoverable and its attached policies can be fetched exactly as the Bedrock
     * pipeline fetches an agent's execution-role policies — same function, same cache.
     *
     * The slash is what identifies that shape, and it is required: IdentityType alone
     * is NOT sufficient. A user federated through IAM Identity Center reports
     * IdentityType 'IAM' but is named after its email ('aanchal@akto.io'), with no
     * session segment and no IAM role behind it. Keying off IdentityType alone turned
     * that email into a fabricated 'role/aanchal@akto.io' ARN and a
     * ListAttachedRolePolicies call that could only ever fail.
     *
     * An '@' in the first segment means an email rather than a role name, so it is
     * skipped too — better to report no role than to invent one.
     */
    const [maybeRoleName, ...sessionParts] = userName.split('/');
    if (sessionParts.length > 0 && maybeRoleName && !maybeRoleName.includes('@')) {
        resolved.executionRole = maybeRoleName;
        resolved.executionRoleArn = `arn:aws:iam::${AWS_ACCOUNT_ID}:role/${maybeRoleName}`;
        resolved.rolePolicies = await getRolePolicies(maybeRoleName);
    }

    quickUsers[userArn] = resolved;
    userCache[userArn] = resolved;
    return resolved;
}

/**
 * Discovers Quick agents not yet in `discoveredAgents` (mutated in place) and returns
 * metadata-only messages for them. Bails early if the time budget is running low —
 * anything not yet discovered stays absent, so it's picked up on the next invocation.
 */
async function discoverNewQuickAgents(discoveredAgents, actionConnectors, timeLeft) {
    const messages = [];

    await refreshActionConnectors(actionConnectors, timeLeft);

    const agents = await listAllQuickAgents();
    console.log(`🔎 Quick ListAgents returned ${agents.length} agent(s)`);

    for (const agent of agents) {
        if (timeLeft() < TIME_SAFETY_MARGIN_MS) { console.warn('⏱️ Time budget low — deferring remaining Quick agent discovery'); return messages; }
        const key = `quick-agent-${agent.AgentId}`;
        if (discoveredAgents[key]) continue;
        try {
            const metadata = await getQuickAgentMetadata(agent.AgentId);
            const arn = metadata?.Arn || agent.Arn || `arn:aws:quicksight:${AWS_REGION}:${AWS_ACCOUNT_ID}:agent/${agent.AgentId}`;
            const agentTags = await getQuickResourceTags(arn);
            const connectorIds = metadata?.ActionConnectors || [];
            const connectorInfo = describeConnectors(connectorIds, actionConnectors);

            messages.push(buildQuickMessage({
                resourceType: 'QUICK_AGENT',
                agentId: agent.AgentId,
                agentName: metadata?.Name || agent.Name || agent.AgentId,
                description: metadata?.Description || agent.Description || '',
                agentStatus: metadata?.AgentStatus || '',
                agentLifecycle: metadata?.AgentLifecycle || '',
                creator: metadata?.Creator || '',
                spaces: metadata?.Spaces || [],
                actionConnectors: connectorIds,
                starterPrompts: metadata?.StarterPrompts || [],
                welcomeMessage: metadata?.WelcomeMessage || '',
                createdAt: metadata?.CreatedAt || agent.CreatedAt,
                updatedAt: metadata?.UpdatedAt || agent.UpdatedAt,
                arn,
                agentTags,
                ...connectorInfo
            }, false));

            discoveredAgents[key] = {
                resourceId: agent.AgentId,
                resourceType: 'QUICK_AGENT',
                resourceName: metadata?.Name || agent.Name || agent.AgentId,
                description: metadata?.Description || agent.Description || '',
                agentArn: arn,
                agentStatus: metadata?.AgentStatus || '',
                agentLifecycle: metadata?.AgentLifecycle || '',
                creator: metadata?.Creator || '',
                spaces: metadata?.Spaces || [],
                actionConnectorIds: connectorIds,
                agentTags,
                discoveredAt: new Date().toISOString()
            };
            console.log(`✅ Discovered Quick agent '${discoveredAgents[key].resourceName}' (${agent.AgentId})${connectorIds.length ? ` with ${connectorIds.length} action connector(s)` : ''}`);
        } catch (error) {
            console.error(`⚠️ Quick discovery failed for agent ${agent.AgentId}: ${error.message}`);
        }
    }

    return messages;
}

/** Rolls a list of connector ids up into the name/type tag values a message carries. */
function describeConnectors(connectorIds, actionConnectors) {
    const resolved = (connectorIds || []).map((id) => actionConnectors[id] || { id, name: id, type: 'UNKNOWN' });
    return {
        connectorNames: resolved.map((c) => c.name).filter(Boolean).join(','),
        connectorTypes: [...new Set(resolved.map((c) => c.type).filter((t) => t && t !== 'UNKNOWN'))].join(',')
    };
}

/**
 * One-time discovery for an agent id that appears in the chat logs but that ListAgents
 * did not return — the same role buildServiceAgentDiscoveryMessage plays in the Bedrock
 * pipeline. Records the agent into `discoveredAgents` (mutated in place) and returns
 * its metadata-only message.
 *
 * ListAgents only returns PUBLISHED agents. An agent being edited in the Quick console
 * also has a separate PREVIEW id, and chatting with the draft logs that PREVIEW id — so
 * this fires routinely on any account where someone is still building an agent, not
 * only for the built-in SYSTEM agent.
 *
 * DescribeAgent DOES work on those ids even though ListAgents omits them, so it is
 * tried first and gives the draft its real name. Without it every preview agent showed
 * up on the dashboard as a bare UUID. Only if DescribeAgent also fails (a genuinely
 * deleted agent, say) does the raw id become the display name.
 */
async function discoverAgentFromLogs(agentId, pair, actionConnectors, discoveredAgents) {
    const isBuiltin = agentId === QUICK_BUILTIN_AGENT_ID;
    const metadata = isBuiltin ? null : await getQuickAgentMetadata(agentId);

    const name = metadata?.Name || (isBuiltin ? QUICK_BUILTIN_AGENT_NAME : agentId);
    const connectorIds = metadata?.ActionConnectors?.length ? metadata.ActionConnectors : (pair.actionConnectorIds || []);
    const arn = metadata?.Arn || `arn:aws:quicksight:${AWS_REGION}:${AWS_ACCOUNT_ID}:agent/${agentId}`;
    const agentTags = metadata ? await getQuickResourceTags(arn) : {};

    const description = metadata?.Description
        || (isBuiltin
            ? 'Amazon Quick Suite built-in chat agent (discovered from chat logs)'
            : `Amazon Quick Suite agent seen in chat logs but not returned by ListAgents${pair.flowId ? ` (flow ${pair.flowId})` : ''}`);

    if (metadata) {
        console.log(`🆕 Quick agent '${name}' (${agentId}) discovered from chat logs — lifecycle ${metadata.AgentLifecycle || 'UNKNOWN'}, so ListAgents omitted it`);
    } else {
        console.warn(`⚠️ Quick agent '${agentId}' appears in chat logs and DescribeAgent could not resolve it either — using the raw id as bot-name (it may have been deleted)`);
    }

    discoveredAgents[`quick-agent-${agentId}`] = {
        resourceId: agentId,
        resourceType: 'QUICK_AGENT',
        // Left unset for the built-in agent so its display name comes from
        // QUICK_BUILTIN_AGENT_NAME rather than being frozen as 'SYSTEM'.
        ...(isBuiltin ? {} : { resourceName: name }),
        description,
        agentArn: arn,
        agentStatus: metadata?.AgentStatus || 'ACTIVE',
        agentLifecycle: metadata?.AgentLifecycle || '',
        creator: metadata?.Creator || '',
        spaces: metadata?.Spaces || [],
        actionConnectorIds: connectorIds,
        agentTags,
        discoveredFrom: 'CHAT_LOGS',
        discoveredAt: new Date().toISOString()
    };

    return buildQuickMessage({
        resourceType: 'QUICK_AGENT',
        agentId,
        agentName: name,
        description,
        agentStatus: metadata?.AgentStatus || 'ACTIVE',
        agentLifecycle: metadata?.AgentLifecycle || '',
        creator: metadata?.Creator || '',
        spaces: metadata?.Spaces || [],
        actionConnectors: connectorIds,
        starterPrompts: metadata?.StarterPrompts || [],
        welcomeMessage: metadata?.WelcomeMessage || '',
        createdAt: metadata?.CreatedAt || pair.timestamp,
        updatedAt: metadata?.UpdatedAt || pair.timestamp,
        arn,
        isBuiltinAgent: isBuiltin,
        agentTags,
        ...describeConnectors(connectorIds, actionConnectors)
    }, false);
}

/**
 * Builds one AKTO message from a Quick chat exchange: resolves the agent's real name,
 * the asking user's permissions, and the action connectors that were in play, then
 * hands everything to buildQuickMessage.
 *
 * `awsMetadata` mirrors the Bedrock pipeline's — model, the effective execution role,
 * and a traceData block — so both render the same way on the AKTO side.
 */
async function createQuickStandardMessage(pair, { discoveredAgents, actionConnectors, quickUsers }) {
    const agentEntry = discoveredAgents[`quick-agent-${pair.agentId}`] || {};
    const isBuiltin = pair.agentId === QUICK_BUILTIN_AGENT_ID;
    const botName = agentEntry.resourceName || (isBuiltin ? QUICK_BUILTIN_AGENT_NAME : pair.agentId);

    if (!agentEntry.resourceName && !isBuiltin && pair.agentId && !reportedMissingAgents.has(pair.agentId)) {
        reportedMissingAgents.add(pair.agentId);
        console.warn(`⚠️ Quick agent '${pair.agentId}' appears in chat logs but was not returned by ListAgents — using the raw id as bot-name (it may have been deleted, or live in another namespace)`);
    }

    const user = await resolveQuickUser(pair, quickUsers);

    // An exchange's connectors take precedence over the agent's configured set: the log
    // records what was actually available to this message.
    const connectorIds = pair.actionConnectorIds.length > 0 ? pair.actionConnectorIds : (agentEntry.actionConnectorIds || []);
    const connectorInfo = describeConnectors(connectorIds, actionConnectors);
    const traceData = buildQuickTraceData({ ...pair, actionConnectorIds: connectorIds }, actionConnectors, botName);

    const awsMetadata = {
        model: QUICK_MODEL_ID,
        'bedrock-execution-role': user.executionRole || '',
        quickAgentId: pair.agentId,
        quickAgentName: botName,
        quickConversationId: pair.conversationId,
        quickUserArn: pair.userArn,
        quickUserRole: user.userRole || '',
        quickIdentityType: user.identityType || '',
        quickIamPolicies: user.iamPolicies || '',
        quickStatusCode: pair.statusCode,
        quickMessageScope: pair.messageScope,
        selectedResources: pair.selectedResources,
        citedResources: pair.citedResources,
        fileAttachments: pair.fileAttachments,
        actionConnectors: connectorIds.map((id) => actionConnectors[id] || { id, name: id, type: 'UNKNOWN' }),
        traceData
    };

    return buildQuickMessage({
        ...pair,
        botName,
        actionConnectorIds: connectorIds,
        isBuiltinAgent: isBuiltin,
        agentStatus: agentEntry.agentStatus || '',
        agentLifecycle: agentEntry.agentLifecycle || '',
        creator: agentEntry.creator || '',
        spaces: agentEntry.spaces || [],
        agentTags: agentEntry.agentTags || {},
        ...connectorInfo,
        ...user,
        awsMetadata
    }, true);
}

/** Clears per-run de-duplication so a warm container doesn't stay silent about a genuinely new problem. */
function resetQuickRunState() {
    reportedMissingAgents.clear();
    for (const key of Object.keys(userCache)) delete userCache[key];
}

module.exports = {
    listAllQuickAgents, getQuickAgentMetadata, getQuickResourceTags, refreshActionConnectors,
    resolveQuickUser, discoverNewQuickAgents, discoverAgentFromLogs,
    createQuickStandardMessage, describeConnectors, resetQuickRunState
};
