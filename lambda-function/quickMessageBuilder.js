/**
 * The single place that knows AKTO's wire format for an Amazon Quick message.
 * Two resource types exist: QUICK_AGENT and QUICK_ACTION_CONNECTOR.
 *
 * `source` is 'AWS_QUICK'. This codebase only ever emits Amazon Quick traffic, so the
 * source names the product it actually came from rather than inheriting the Bedrock
 * value the pipeline started from. The AKTO ingestion side must recognise this value for
 * the messages to categorise — if agents stop appearing on the dashboard after a deploy,
 * this is the first thing to check.
 *
 * agentType still separates the two resource kinds within Quick:
 * 'QUICK_SUITE_AGENT' for agents, 'QUICK_ACTION_CONNECTOR' for MCP connectors.
 */
const { AWS_REGION, AWS_ACCOUNT_ID, QUICK_MODEL_ID, QUICK_BUILTIN_AGENT_ID, CODE_VERSION } = require('./config');
const { summarizeResources } = require('./quickParser');

/**
 * Anything outside this set is stripped from a bot name before it is sent.
 *
 * Agent names are free text in the Quick console, and a name containing '&' was being
 * rejected downstream while every plain-ASCII name went through — "Email Draft & Send
 * Agent" never appeared on the dashboard although the message left here intact. Rather
 * than depend on every consumer handling punctuation identically, punctuation is stripped
 * at the boundary.
 *
 * Letters and digits of ANY script are kept (\p{L}\p{N}, not A-Za-z0-9): an agent named
 * in Japanese or Hindi is a perfectly ordinary name, and an ASCII-only allowlist would
 * erase it completely and fall back to showing a bare UUID. Only punctuation goes.
 */
const BOT_NAME_DISALLOWED = /[^\p{L}\p{N} _.\-]/gu;

/**
 * Normalises an agent name into the `bot-name` tag the dashboard groups on.
 *
 * Two things happen here:
 *
 * 1. Special characters are removed and the leftover whitespace collapsed, so
 *    "Email Draft & Send Agent" becomes "Email Draft Send Agent".
 *
 * 2. The built-in agent gets the account id appended. AWS names the default agent
 *    "Quick" with the fixed id "SYSTEM" in EVERY account, so without this every account's
 *    built-in agent arrives with an identical name and they collapse into one entry —
 *    only the last account written stays visible. "Quick-041877753357" keeps them apart
 *    and reads unambiguously when several accounts are listed together.
 *
 * Matched on the id as well as the name so a future rename of the default agent doesn't
 * quietly reintroduce the collision.
 */
function sanitizeBotName(rawName, agentId) {
    let name = String(rawName || '').replace(BOT_NAME_DISALLOWED, ' ').replace(/\s+/g, ' ').trim();
    // Never emit an empty bot-name: the id is a poor label but an unlabelled agent is worse.
    if (!name) name = String(agentId || '').replace(BOT_NAME_DISALLOWED, ' ').replace(/\s+/g, ' ').trim() || 'unknown';
    if (name.toLowerCase() === 'quick' || agentId === QUICK_BUILTIN_AGENT_ID) {
        name = `${name}-${AWS_ACCOUNT_ID}`;
    }
    return name;
}

/** Drops empty tag values so the dashboard isn't littered with blank keys for fields this account doesn't deliver. */
function compact(tags) {
    const out = {};
    for (const [key, value] of Object.entries(tags)) {
        if (value === undefined || value === null || value === '') continue;
        out[key] = String(value);
    }
    return out;
}

/**
 * Builds one AKTO-format message, either from a real Quick chat exchange
 * (isConversation=true) or from Quick agent discovery metadata (false). Both shapes
 * share one envelope, so this is one function with two branches rather than two
 * near-duplicate builders.
 */
function buildQuickMessage(data, isConversation) {
    const timestamp = isConversation ? Math.floor(new Date(data.timestamp).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const region = isConversation ? (data.region || AWS_REGION) : AWS_REGION;
    const accountId = isConversation ? (data.accountId || AWS_ACCOUNT_ID) : AWS_ACCOUNT_ID;
    // Quick Suite is served by the QuickSight control plane, so this is the real host
    // the traffic belongs to rather than a synthetic one.
    const originalHost = `quicksight.${region}.amazonaws.com`;

    const agentId = data.agentId || '';
    // Sanitised at the boundary so every consumer sees the same value, whether it came
    // from a conversation pair or from discovery metadata.
    const resourceName = sanitizeBotName(isConversation ? data.botName : data.agentName, agentId);

    const requestHeaders = {
        'Content-Type': 'application/json',
        'X-Bedrock-Model-Id': QUICK_MODEL_ID,
        'quick-agent-id': agentId,
        'agent-name': resourceName || '',
        'bedrock-region': region,
        'aws-account-id': accountId,
        'bedrock-operation': isConversation ? 'Chat' : 'DISCOVERY',
        'bedrock-identity-arn': data.userArn || data.arn || '',
        host: originalHost,
        ...(isConversation
            ? {
                'X-Request-Id': data.requestId || '',
                'quick-conversation-id': data.conversationId || '',
                'quick-user-arn': data.userArn || ''
            }
            : {})
    };

    const requestPayload = isConversation
        ? { messages: [{ role: 'user', content: [{ type: 'text', text: data.userMessage }] }] }
        : {
            resourceId: agentId,
            resourceName,
            resourceType: data.resourceType,
            description: data.description || '',
            status: data.agentStatus,
            lifecycle: data.agentLifecycle,
            creator: data.creator,
            foundationModel: QUICK_MODEL_ID,
            spaces: data.spaces || [],
            actionConnectors: data.actionConnectors || [],
            starterPrompts: data.starterPrompts || [],
            welcomeMessage: data.welcomeMessage || '',
            createdAt: data.createdAt,
            updatedAt: data.updatedAt
        };

    const responsePayload = isConversation
        ? {
            output: { message: { role: 'assistant', content: [{ text: data.agentResponse }] } },
            // Quick reports neither token count. Kept at zero so the field exists and
            // the shape matches the Bedrock pipeline rather than being absent.
            usage: { inputTokens: 0, outputTokens: 0 },
            awsMetadata: data.awsMetadata || {}
        }
        : {
            awsMetadata: {
                agentStatus: data.agentStatus,
                agentLifecycle: data.agentLifecycle,
                createdAt: data.createdAt,
                updatedAt: data.updatedAt,
                spaces: data.spaces || [],
                actionConnectors: data.actionConnectors || []
            }
        };

    const tags = compact({
        source: 'AWS_QUICK',
        'gen-ai': 'Gen AI',
        'account-id': accountId,
        region,
        // The build that produced this message. Carried on every message rather than
        // announced separately, so the version a message came from is visible wherever
        // the message is — which is how a rollout is confirmed: watch the tag change on
        // live traffic instead of trusting that an update was applied.
        'lambda-version': CODE_VERSION,
        agentType: 'QUICK_SUITE_AGENT',
        'bot-name': resourceName || '',
        'agent-id': agentId,
        model: QUICK_MODEL_ID,
        'bedrock-identity-arn': data.userArn || data.arn || '',

        ...(isConversation
            ? {
                operation: 'Chat',
                'input-tokens': '0',
                'output-tokens': '0',

                // Conversation/message correlation — quick-system-message-id is also the
                // join key to the FEEDBACK_LOGS log type, if that delivery is enabled.
                'quick-conversation-id': data.conversationId,
                'quick-user-message-id': data.userMessageId,
                'quick-system-message-id': data.systemMessageId,

                // Who asked. userRole/identityType/email/policies come from
                // DescribeUser + ListIAMPolicyAssignmentsForUser (quickDiscovery).
                'quick-user-arn': data.userArn,
                'quick-user-name': data.userName,
                'quick-user-type': data.userType,
                'quick-user-role': data.userRole,
                'quick-identity-type': data.identityType,
                'quick-user-email': data.userEmail,
                'quick-custom-permissions': data.customPermissions,
                'quick-namespace': data.namespace,

                // How it was asked, and how it went.
                'quick-status-code': data.statusCode,
                'quick-message-scope': data.messageScope,
                'quick-flow-id': data.flowId,
                'quick-surface-type': data.surfaceType,
                'quick-web-search': data.webSearch,
                'quick-latency-ms': data.latencyMs,
                'quick-ttft-ms': data.timeToFirstTokenMs,

                // What it touched.
                'quick-selected-resources': summarizeResources(data.selectedResources || []),
                'quick-cited-resources': summarizeResources(data.citedResources || []),
                'quick-cited-resource-count': String((data.citedResources || []).length),
                'quick-file-attachments': (data.fileAttachments || []).map((f) => f.name).filter(Boolean).join(','),
                'quick-file-count': String((data.fileAttachments || []).length),

                // The agent's tools, resolved to names/types via DescribeActionConnector.
                'quick-action-connectors': data.connectorNames,
                'quick-connector-types': data.connectorTypes,
                'quick-connector-count': String((data.actionConnectorIds || []).length),

                // Agent-level metadata, carried onto every conversation so a message is
                // self-describing without joining back to its discovery message.
                'quick-agent-status': data.agentStatus,
                'quick-agent-lifecycle': data.agentLifecycle,
                'quick-agent-creator': data.creator,
                'quick-spaces': (data.spaces || []).join(','),
                'quick-builtin-agent': data.isBuiltinAgent ? 'true' : '',

                // Quick agents have no execution role of their own, so these carry the
                // asking user's effective permissions instead. Same tag names the Bedrock
                // pipeline uses, so existing dashboard fields populate unchanged.
                'quick-iam-policies': data.iamPolicies,
                'bedrock-execution-role': data.executionRole,
                'bedrock-execution-role-arn': data.executionRoleArn,
                'bedrock-role-policies': data.rolePolicies,

                ...(data.agentTags || {})
            }
            : {
                'discovery-type': 'METADATA_ONLY',
                'has-conversations': 'false',
                'quick-agent-status': data.agentStatus,
                'quick-agent-lifecycle': data.agentLifecycle,
                'quick-agent-creator': data.creator,
                'quick-spaces': (data.spaces || []).join(','),
                'quick-action-connectors': data.connectorNames,
                'quick-connector-types': data.connectorTypes,
                'quick-builtin-agent': data.isBuiltinAgent ? 'true' : '',
                ...(data.agentTags || {})
            })
    });

    return {
        // Quick has no per-model route, so the path names the agent and the operation
        // that actually happened rather than borrowing Bedrock's /model/… shape.
        path: isConversation ? `/quick/agents/${agentId || 'unknown'}/chat` : `/quick/agents/${agentId || 'unknown'}/discovery`,
        original_host: originalHost,
        method: 'POST',
        requestHeaders: JSON.stringify(requestHeaders),
        responseHeaders: JSON.stringify({ 'Content-Type': 'application/json', ...(isConversation && { 'X-Request-Id': data.requestId || '' }) }),
        requestPayload: JSON.stringify(requestPayload),
        responsePayload: JSON.stringify(responsePayload),
        ip: '0.0.0.0',
        time: timestamp.toString(),
        // Quick's own status_code ('success', 'request_blocked', 'no_answer_found') is
        // reported as a tag rather than as an HTTP status: the delivery itself succeeded,
        // and rewriting it to 4xx would make blocked prompts look like transport failures.
        statusCode: '200',
        type: 'HTTP',
        status: 'OK',
        akto_account_id: '1000000',
        akto_vxlan_id: '0',
        is_pending: 'false',
        source: 'MIRRORING',
        tag: JSON.stringify(tags),
        publishToGuardrails: true
    };
}

/**
 * Builds a metadata-only discovery message for one action connector.
 *
 * Action connectors are the tools a Quick agent can invoke — Jira, Slack, Google Slides,
 * and, most importantly here, MCP servers. They were previously visible only as tool
 * names inside a conversation's traceData, which meant a connector nobody had chatted
 * through yet was invisible: you could register an MCP server pointing anywhere and
 * nothing would show it until someone happened to use it.
 *
 * The two fields that make this a security artefact rather than an inventory entry are
 * `baseEndpoint` (the external URL the agent can reach) and `authType` (how, or whether,
 * that URL is guarded). Secrets are never included — only the endpoint and the NAME of
 * the auth mechanism, never keys, tokens or client secrets.
 *
 * The path is account-scoped from the outset. Connector ids are UUIDs and unlikely to
 * collide, but the built-in agent's fixed 'SYSTEM' id already taught us what happens when
 * two accounts emit the same endpoint.
 */
function buildQuickConnectorMessage(connector, usedByAgents = []) {
    const timestamp = Math.floor(Date.now() / 1000);
    const name = sanitizeBotName(connector.name, connector.id);
    const isMcp = String(connector.type || '').toUpperCase().includes('MODEL_CONTEXT_PROTOCOL');

    /*
     * The MCP server's own URL becomes the endpoint, rather than a synthetic
     * /quick/connectors/... path.
     *
     * An MCP server IS an external API that the agent calls, so modelling it as itself —
     * host mcp.server.com, path / — is what makes it show up as a real endpoint rather
     * than as a made-up route under quicksight.amazonaws.com. Two accounts pointing at
     * the same MCP server then converge on one endpoint, which is accurate: it is one
     * server, and the account-id tag still distinguishes who reaches it.
     *
     * Falls back to the synthetic path when the connector exposes no BaseEndpoint, so a
     * connector is never dropped for lack of a URL.
     */
    let originalHost = `quicksight.${AWS_REGION}.amazonaws.com`;
    let path = `/quick/connectors/${AWS_ACCOUNT_ID}/${connector.id || 'unknown'}/discovery`;
    if (connector.baseEndpoint) {
        try {
            const url = new URL(connector.baseEndpoint);
            originalHost = url.host;
            /*
             * Keep the URL's real path when it has one, but not when it is a bare '/'.
             *
             * Most MCP servers are addressed at the root (https://mcp.server.com), whose
             * pathname is '/'. Emitting that gives a dashboard row reading "POST /", which
             * says nothing about what the endpoint is — and worse, two connectors pointing
             * at the same server root (one OAuth, one API key, say) would produce an
             * identical host+path and merge into a single endpoint.
             *
             * The host is the signal worth keeping: it is what puts the external server in
             * the endpoint inventory at all. The path carries no information here, so it is
             * spent on an obviously-synthetic identifier that keeps connectors distinct.
             * A URL that genuinely has a path (/mcp/v1, /sse) keeps it untouched.
             */
            const urlPath = url.pathname || '/';
            path = urlPath === '/'
                ? `/quick/connectors/${connector.id || 'unknown'}`
                : urlPath;
        } catch {
            // Not a parseable URL — keep the synthetic endpoint rather than emitting junk.
        }
    }

    const requestPayload = {
        resourceId: connector.id,
        resourceName: connector.name,
        resourceType: 'QUICK_ACTION_CONNECTOR',
        connectorType: connector.type,
        description: connector.description || '',
        status: connector.status || '',
        baseEndpoint: connector.baseEndpoint || '',
        authenticationType: connector.authType || '',
        tokenEndpoint: connector.tokenEndpoint || '',
        authorizationEndpoint: connector.authorizationEndpoint || '',
        clientId: connector.clientId || '',
        enabledActions: connector.enabledActions || [],
        vpcConnectionArn: connector.vpcConnectionArn || '',
        usedByAgents,
        createdAt: connector.createdTime || '',
        updatedAt: connector.lastUpdatedTime || ''
    };

    const tags = compact({
        source: 'AWS_QUICK',
        'gen-ai': 'Gen AI',
        'account-id': AWS_ACCOUNT_ID,
        region: AWS_REGION,
        'lambda-version': CODE_VERSION,
        agentType: 'QUICK_ACTION_CONNECTOR',
        'bot-name': name,
        'agent-id': connector.id,
        model: QUICK_MODEL_ID,
        'discovery-type': 'METADATA_ONLY',
        'has-conversations': 'false',
        'quick-connector-id': connector.id,
        'quick-connector-type': connector.type || 'UNKNOWN',
        // Called out separately so MCP servers can be filtered without string-matching
        // the type: they are arbitrary third-party tool servers and warrant their own view.
        'quick-is-mcp': isMcp ? 'true' : '',
        // Display-label tag, same shape as 'gen-ai': the key is what you filter on and the
        // value is what the dashboard shows. Present only on MCP connectors, so its mere
        // presence is the filter — no need to match on a value.
        'mcp-server': isMcp ? 'MCP Server' : '',
        'quick-connector-endpoint': connector.baseEndpoint || '',
        'quick-connector-auth': connector.authType || '',
        // Which identity provider guards this MCP server, and under which OAuth client.
        // ClientId is an identifier, not a credential; the secret is never returned by
        // the API and is never read here.
        'quick-connector-token-endpoint': connector.tokenEndpoint || '',
        'quick-connector-authorize-endpoint': connector.authorizationEndpoint || '',
        'quick-connector-client-id': connector.clientId || '',
        // An unauthenticated external tool server is worth surfacing on its own.
        'quick-connector-unauthenticated': String(connector.authType || '').toUpperCase() === 'NONE' ? 'true' : '',
        'quick-connector-actions': (connector.enabledActions || []).join(','),
        'quick-connector-action-count': String((connector.enabledActions || []).length),
        'quick-connector-status': connector.status || '',
        'quick-connector-vpc': connector.vpcConnectionArn || '',
        'quick-used-by-agents': usedByAgents.join(',')
    });

    return {
        path,
        original_host: originalHost,
        method: 'POST',
        requestHeaders: JSON.stringify({
            'Content-Type': 'application/json',
            'X-Bedrock-Model-Id': QUICK_MODEL_ID,
            'bedrock-region': AWS_REGION,
            'aws-account-id': AWS_ACCOUNT_ID,
            'bedrock-operation': 'DISCOVERY',
            host: originalHost
        }),
        responseHeaders: JSON.stringify({ 'Content-Type': 'application/json' }),
        requestPayload: JSON.stringify(requestPayload),
        responsePayload: JSON.stringify({
            awsMetadata: {
                connectorType: connector.type,
                baseEndpoint: connector.baseEndpoint || '',
                authenticationType: connector.authType || '',
                tokenEndpoint: connector.tokenEndpoint || '',
                authorizationEndpoint: connector.authorizationEndpoint || '',
                clientId: connector.clientId || '',
                enabledActions: connector.enabledActions || [],
                vpcConnectionArn: connector.vpcConnectionArn || '',
                usedByAgents
            }
        }),
        ip: '0.0.0.0',
        time: timestamp.toString(),
        statusCode: '200',
        type: 'HTTP',
        status: 'OK',
        akto_account_id: '1000000',
        akto_vxlan_id: '0',
        is_pending: 'false',
        source: 'MIRRORING',
        tag: JSON.stringify(tags),
        publishToGuardrails: true
    };
}

module.exports = { buildQuickMessage, buildQuickConnectorMessage, sanitizeBotName };
