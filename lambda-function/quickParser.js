/**
 * Pure functions that turn one Amazon Quick Suite vended log record into an
 * AKTO-shaped conversation pair. No AWS calls, no shared state — the Quick
 * equivalent of extractors.js.
 *
 * The shape is nothing like a Bedrock model-invocation log, which is why this is a
 * separate parser rather than a branch in extractors.js. The important differences:
 *
 *   - One record IS one complete exchange. `user_message` and `system_text_message`
 *     are both present on the same record, so there is no pairing to do across
 *     records and no conversation history to de-duplicate.
 *   - There is no model id and no token count. Quick doesn't report which model
 *     answered, so callers substitute a synthetic id (config.QUICK_MODEL_ID) and
 *     zero tokens rather than emitting 'unknown-model' everywhere.
 *   - The tool calls are `action_connectors` — Quick's integrations with Jira,
 *     ServiceNow, Slack, S3, Bedrock and so on. They are the direct analogue of a
 *     Bedrock toolUse block, so buildQuickTraceData below renders them into the same
 *     executionFlow/toolsSummary shape extractors.extractTraceData produces.
 *
 * Field names are read through pick() because the AWS documentation and the data
 * actually delivered disagree on casing in three places (documented
 * `{resource_type, resource_id}` arrives as `{resourceType, resourceId}`, documented
 * `action_connector_id` arrives as `actionConnectorId`, and `logType` is spelled
 * `log_type` on some log types). Accepting both costs nothing and avoids a silent
 * total data loss if AWS settles on either spelling.
 */
const { AWS_REGION, AWS_ACCOUNT_ID, MAX_TRACE_BYTES, QUICK_NAMESPACE } = require('./config');
const { capTraceData } = require('./extractors');

/** First present, non-empty value among several candidate field names. */
function pick(record, ...names) {
    if (!record || typeof record !== 'object') return undefined;
    for (const name of names) {
        const value = record[name];
        if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
}

/**
 * Trimmed string form of a picked field, or '' — keeps every tag value a string.
 *
 * A lone '-' is treated as absent: Quick writes it as a null placeholder (`flow_id`
 * is '-' on any exchange that isn't flow-driven, which is most of them), and carrying
 * it through would put a meaningless '-' on the dashboard instead of nothing.
 */
function str(record, ...names) {
    const value = pick(record, ...names);
    if (value === undefined) return '';
    const text = String(value).trim();
    return text === '-' ? '' : text;
}

/** Always an array, whether the field is absent, a single object, or already a list. */
function arr(record, ...names) {
    const value = pick(record, ...names);
    if (value === undefined) return [];
    return Array.isArray(value) ? value.filter((v) => v !== null && v !== undefined) : [value];
}

/**
 * True if this record is a chat log rather than one of the other Quick log types.
 *
 * A client can point several delivery sources (CHAT_LOGS, FEEDBACK_LOGS,
 * AGENT_HOURS_LOGS, INDEX_USAGE_LOGS, KB_FILE_SYNC_LOGS) at the same bucket prefix,
 * in which case this pipeline sees all of them and must ignore the rest rather than
 * emit garbage conversations. Matched by prefix because AWS documents the value as
 * both 'CHAT_LOGS' (the delivery-source logType) and 'Chat' (the common-fields table).
 */
function isChatLog(record) {
    return String(pick(record, 'logType', 'log_type') || '').trim().toUpperCase().startsWith('CHAT');
}

/** The log type as written, for stats and for reporting what non-chat traffic was skipped. */
function logTypeOf(record) {
    return String(pick(record, 'logType', 'log_type') || 'UNKNOWN').trim().toUpperCase();
}

/**
 * Quick stamps `event_timestamp` as epoch milliseconds. Values below ~2001 in ms are
 * treated as seconds instead, so a future change to the unit degrades to a slightly
 * odd timestamp rather than to 1970 on every single message.
 */
function toIsoTimestamp(raw) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && numeric > 0) {
        const ms = numeric < 1e12 ? numeric * 1000 : numeric;
        const date = new Date(ms);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
    }
    if (raw) {
        const parsed = new Date(raw);
        if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    return new Date().toISOString();
}

/**
 * Splits a Quick user ARN into its namespace and user name.
 *
 *   arn:aws:quicksight:us-east-1:1234:user/default/aanchal@akto.io
 *     → { namespace: 'default', userName: 'aanchal@akto.io' }
 *
 * IAM-federated users carry the role and session in the name itself
 * (`default/MyRole/session-id`), which is what makes the execution-role lookup in
 * quickDiscovery possible — hence the greedy tail rather than a single segment.
 */
function parseQuickUserArn(userArn) {
    const match = String(userArn || '').match(/:user\/([^/]+)\/(.+)$/);
    if (!match) return { namespace: QUICK_NAMESPACE, userName: '' };
    return { namespace: match[1], userName: match[2] };
}

/** Region and account from any Quick ARN, falling back to the Lambda's own. */
function parseQuickResourceArn(resourceArn) {
    const parts = String(resourceArn || '').split(':');
    return {
        region: parts[3] || AWS_REGION,
        accountId: parts[4] || AWS_ACCOUNT_ID
    };
}

/** Normalizes a resource reference, accepting both the documented and the delivered casing. */
function normalizeResource(item) {
    if (!item || typeof item !== 'object') return { id: String(item || ''), type: '', name: '' };
    return {
        id: str(item, 'resourceId', 'resource_id', 'citedResourceId', 'cited_resource_id'),
        type: str(item, 'resourceType', 'resource_type', 'citedResourceType', 'cited_resource_type'),
        name: str(item, 'resourceName', 'resource_name', 'citedResourceName', 'cited_resource_name')
    };
}

/** Normalizes a file attachment reference. Note AWS's own docs typo this as `file_attachmet_type`. */
function normalizeAttachment(item) {
    if (!item || typeof item !== 'object') return { name: String(item || ''), type: '' };
    return {
        name: str(item, 'fileAttachmentName', 'file_attachment_name'),
        // 'file_attachmet_type' is not a typo here — it is the spelling in the AWS
        // documentation's own example payload, so both are accepted.
        type: str(item, 'fileAttachmentType', 'file_attachment_type', 'fileAttachmetType', 'file_attachmet_type')
    };
}

/** Pulls the connector id out of an action_connectors entry. */
function normalizeConnectorId(item) {
    if (!item || typeof item !== 'object') return String(item || '');
    return str(item, 'actionConnectorId', 'action_connector_id', 'connectorId', 'id');
}

/** Compact "type:id" list for a tag value — readable in the dashboard without JSON. */
function summarizeResources(resources) {
    return resources
        .map((r) => [r.type, r.name || r.id].filter(Boolean).join(':'))
        .filter(Boolean)
        .join(',');
}

/**
 * Turns one raw Quick chat-log record into a normalized conversation pair, or null if
 * it isn't a chat record or carries no actual exchange.
 *
 * Every field the record offers is kept, not just the conversation: the caller writes
 * the non-conversation ones out as AKTO tags, which is where the operational value of
 * these logs is (who asked, under what scope, against which resources, with which
 * connectors, and whether the request was blocked).
 */
function parseQuickRecord(record) {
    if (!record || typeof record !== 'object') return null;
    if (!isChatLog(record)) return null;

    const userMessage = str(record, 'user_message', 'userMessage');
    const agentResponse = str(record, 'system_text_message', 'systemTextMessage');
    // A record with neither side carries no exchange to report. Quick emits these for
    // blocked or no-answer requests, which the caller counts separately.
    if (!userMessage && !agentResponse) return null;

    const resourceArn = str(record, 'resource_arn', 'resourceArn');
    const { region, accountId } = parseQuickResourceArn(resourceArn);
    const userArn = str(record, 'user_arn', 'userArn');
    const { namespace: arnNamespace, userName } = parseQuickUserArn(userArn);

    const selectedResources = arr(record, 'user_selected_resources', 'userSelectedResources').map(normalizeResource);
    const citedResources = arr(record, 'cited_resource', 'citedResource', 'cited_resources').map(normalizeResource);
    const fileAttachments = arr(record, 'file_attachment', 'fileAttachment', 'file_attachments').map(normalizeAttachment);
    const actionConnectorIds = arr(record, 'action_connectors', 'actionConnectors').map(normalizeConnectorId).filter(Boolean);

    return {
        logType: 'QUICK_AGENT',
        timestamp: toIsoTimestamp(pick(record, 'event_timestamp', 'eventTimestamp')),
        // Quick has no per-request id; the system message id is the closest stable
        // per-exchange identifier and is what correlates a chat log with its feedback log.
        requestId: str(record, 'system_message_id', 'systemMessageId'),
        accountId: str(record, 'accountId', 'account_id') || accountId,
        region,
        resourceArn,

        agentId: str(record, 'agent_id', 'agentId'),
        flowId: str(record, 'flow_id', 'flowId'),

        userMessage,
        agentResponse,
        conversationId: str(record, 'conversation_id', 'conversationId'),
        userMessageId: str(record, 'user_message_id', 'userMessageId'),
        systemMessageId: str(record, 'system_message_id', 'systemMessageId'),

        userArn,
        userName,
        userType: str(record, 'user_type', 'userType'),
        namespace: str(record, 'namespace') || arnNamespace,

        statusCode: str(record, 'status_code', 'statusCode'),
        messageScope: str(record, 'message_scope', 'messageScope'),

        // The five fields AWS does not deliver by default — they only appear when the
        // client named them in CreateDelivery. Absent is normal, not an error.
        surfaceType: str(record, 'surface_type', 'surfaceType'),
        webSearch: str(record, 'web_search', 'webSearch'),
        latencyMs: str(record, 'latency'),
        timeToFirstTokenMs: str(record, 'time_to_first_token', 'timeToFirstToken'),

        selectedResources,
        citedResources,
        fileAttachments,
        actionConnectorIds,

        // Quick reports neither, but the AKTO message shape expects them.
        inputTokenCount: 0,
        outputTokenCount: 0
    };
}

/**
 * True if a parsed record carries none of the opt-in ("starred") delivery fields.
 *
 * `namespace` is deliberately not tested even though AWS stars it: it's recoverable
 * from the user ARN, so it's always populated and would mask the check. The four
 * tested here have no other source — if they're absent, the delivery didn't request them.
 */
function missingOptionalFields(pair) {
    return !pair.surfaceType && !pair.webSearch && !pair.latencyMs && !pair.timeToFirstTokenMs;
}

/**
 * Renders a Quick exchange's action connectors into the same executionFlow /
 * toolsSummary shape extractors.extractTraceData builds for Bedrock tool calls, so
 * both pipelines' traces render identically on the AKTO side.
 *
 * Action connectors ARE Quick's tools — they are what lets an agent create a Jira
 * issue or open a ServiceNow incident rather than only answer from data. `connectors`
 * is the resolved index from quickDiscovery (id → name/type/enabledActions); an id
 * missing from it still produces a step, just named after the raw id.
 *
 * Unlike a Bedrock toolUse, a Quick chat log records which connectors were *available
 * to* the exchange, not which ones actually fired, and never their results — so steps
 * carry no `result` field and the flow is capped only for safety.
 */
function buildQuickTraceData(pair, connectors = {}, botName, maxBytes = MAX_TRACE_BYTES) {
    try {
        const tools = new Set();
        const actions = new Set();
        const executionFlow = [{
            step: 0,
            type: 'agent',
            name: botName || pair.agentId,
            action: 'orchestrate',
            description: 'Quick Suite agent orchestrating action connectors'
        }];

        pair.actionConnectorIds.forEach((connectorId, index) => {
            const connector = connectors[connectorId] || {};
            const name = connector.name || connectorId;
            const enabledActions = Array.isArray(connector.enabledActions) ? connector.enabledActions : [];
            executionFlow.push({
                step: index + 1,
                type: 'action-connector',
                tool: name,
                connectorId,
                connectorType: connector.type || 'UNKNOWN',
                action: enabledActions.join(',') || 'unknown',
                status: connector.status || '',
                description: connector.description || ''
            });
            tools.add(name);
            enabledActions.forEach((a) => actions.add(a));
        });

        // Cited resources are what the answer was actually grounded in — the closest
        // thing Quick gives to a tool *result*, so they ride along in the trace rather
        // than only in tags.
        pair.citedResources.forEach((resource, index) => {
            const label = resource.name || resource.id;
            if (!label) return;
            executionFlow.push({
                step: pair.actionConnectorIds.length + index + 1,
                type: 'cited-resource',
                tool: resource.type || 'resource',
                action: 'cite',
                result: label
            });
        });

        if (executionFlow.length === 1) return { executionFlow: [], toolsSummary: {} };

        return capTraceData({
            executionFlow,
            toolsSummary: {
                agentOrchestrator: botName || pair.agentId,
                tools: [...tools],
                actions: [...actions],
                totalToolCalls: pair.actionConnectorIds.length,
                executionPattern: `${botName || pair.agentId}${tools.size ? `→${[...tools].join('→')}` : ''}`
            }
        }, maxBytes);
    } catch (error) {
        console.warn(`⚠️ Quick trace extraction failed: ${error.message}`);
        return { executionFlow: [], toolsSummary: {} };
    }
}

module.exports = {
    pick, str, arr, isChatLog, logTypeOf, toIsoTimestamp, parseQuickUserArn, parseQuickResourceArn,
    normalizeResource, normalizeAttachment, normalizeConnectorId, summarizeResources,
    parseQuickRecord, missingOptionalFields, buildQuickTraceData
};
