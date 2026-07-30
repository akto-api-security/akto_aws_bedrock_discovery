/**
 * Parses CloudWatch log records for one AgentCore trace and reconstructs a
 * conversation pair from them. A single log group/stream carries four record
 * shapes multiplexed together (see classifyRecord):
 *   - SPAN: the OTel span (name/kind/startTimeUnixNano at top level). Carries
 *     harness.id, gen_ai.request.model, session.id — never message text.
 *   - STRANDS_AGGREGATE: a whole-trace input/output summary logged by the
 *     Strands Agents framework's tracer (scope.name === "strands.telemetry.tracer"),
 *     body.input.messages/output.messages.
 *   - GENAI_EVENT: one message at a time (eventName starting "gen_ai."),
 *     emitted by generic botocore auto-instrumentation — framework-agnostic,
 *     used when no Strands aggregate is present.
 *   - OTHER: plain OTel logs and EMF metrics — discarded.
 *
 * All four carry the same traceId and resource.attributes (including
 * "cloud.resource_id", the runtime ARN), so identity is resolved by merging
 * across every record in a trace rather than reading a single one.
 */
const { AWS_REGION, AWS_ACCOUNT_ID } = require('./config');

/** Classifies one parsed CloudWatch Logs record by shape — see file header. */
function classifyRecord(record) {
    if (typeof record.traceId === 'string' && record.traceId
        && typeof record.spanId === 'string' && record.spanId
        && typeof record.name === 'string' && typeof record.startTimeUnixNano !== 'undefined') {
        return 'SPAN';
    }
    if (record.scope?.name === 'strands.telemetry.tracer' && (record.body?.input?.messages || record.body?.output?.messages)) {
        return 'STRANDS_AGGREGATE';
    }
    if (typeof record.eventName === 'string' && record.eventName.startsWith('gen_ai.')) {
        return 'GENAI_EVENT';
    }
    return 'OTHER';
}

/** Parses one CloudWatch log event's message as JSON. Returns null for anything unparseable (each JSON line has a plain-text duplicate logged alongside it, so this is routine). */
function parseLogRecord(logEvent) {
    try {
        return JSON.parse(logEvent.message);
    } catch {
        return null;
    }
}

/** Pulls the runtime ID out of its full ARN (arn:aws:bedrock-agentcore:region:account:runtime/<runtime-id>/runtime-endpoint/<endpoint>). */
function extractRuntimeIdFromArn(arn) {
    const match = arn?.match(/:runtime\/([^/]+)\//);
    return match ? match[1] : '';
}

/** Pulls a harness's own name out of its runtime's service.name (e.g. "harness_wb5n7.DEFAULT" -> "wb5n7") — AgentCore always names a Harness-backed runtime "harness_<harnessName>". */
function extractHarnessNameFromServiceName(serviceName) {
    const runtimeName = serviceName?.split('.')[0] || '';
    const match = runtimeName.match(/^harness_(.+)$/);
    return match ? match[1] : '';
}

/** Pulls identity fields off one record. Uniform across spans and content records; harness.id/gen_ai.request.model are typically only present on spans, which is why resolveTraceIdentity merges across a whole trace. */
function extractIdentityFromRecord(record) {
    const resourceAttrs = record.resource?.attributes || {};
    const attributes = record.attributes || {};
    const resourceArn = resourceAttrs['cloud.resource_id'] || '';
    return {
        traceId: record.traceId || '',
        spanId: record.spanId || '',
        resourceArn,
        runtimeId: extractRuntimeIdFromArn(resourceArn),
        harnessId: attributes['harness.id'] || '',
        serviceName: resourceAttrs['service.name'] || '',
        sessionId: attributes['session.id'] || attributes['gen_ai.conversation.id'] || resourceAttrs['session.id'] || '',
        modelId: attributes['gen_ai.request.model'] || attributes['gen_ai.response.model'] || '',
        startTimeUnixNano: record.startTimeUnixNano || record.timeUnixNano || null
    };
}

/** Merges identity fields across every record sharing one traceId. First non-empty value per field wins. */
function resolveTraceIdentity(records) {
    const merged = { traceId: '', spanId: '', resourceArn: '', runtimeId: '', harnessId: '', serviceName: '', sessionId: '', modelId: '', startTimeUnixNano: null };
    for (const record of records) {
        const identity = extractIdentityFromRecord(record);
        for (const key of Object.keys(merged)) {
            if (!merged[key] && identity[key]) merged[key] = identity[key];
        }
    }
    return merged;
}

/** Reads message text out of one input/output message object. `content` takes several shapes (plain string, content-block array, JSON-encoded-string wrapper, plain-string `.message` field) — all handled here. */
function extractMessageText(message) {
    const content = message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((c) => c?.text || '').filter(Boolean).join(' ');
    if (content && typeof content === 'object') {
        if (typeof content.message === 'string') return content.message;
        if (typeof content.content === 'string') {
            try {
                const parsed = JSON.parse(content.content);
                if (Array.isArray(parsed)) return parsed.map((c) => c?.text || '').filter(Boolean).join(' ');
            } catch {
                return content.content;
            }
            return content.content;
        }
    }
    return '';
}

/** Extracts text out of a gen_ai event's content-block array (e.g. [{text: "..."}]). */
function extractTextFromContentBlocks(content) {
    if (!Array.isArray(content)) return '';
    return content.map((c) => c?.text || '').filter(Boolean).join(' ');
}

/** Extracts the conversation pair from a Strands whole-trace aggregate: last user message in input.messages, paired with the last assistant message in output.messages. */
function extractConversationContentFromStrandsAggregate(record) {
    const inputMessages = record.body?.input?.messages || [];
    const outputMessages = record.body?.output?.messages || [];
    const lastUser = [...inputMessages].reverse().find((m) => m.role === 'user');
    const lastAssistant = [...outputMessages].reverse().find((m) => m.role === 'assistant');
    return {
        userMessage: lastUser ? extractMessageText(lastUser) : '',
        agentResponse: lastAssistant ? extractMessageText(lastAssistant) : ''
    };
}

/** Reconstructs a conversation pair from individual gen_ai.*.message/gen_ai.choice events — the framework-agnostic fallback. Prefers gen_ai.choice over a raw gen_ai.assistant.message when both are present. */
function extractConversationContentFromGenAiEvents(records) {
    const userTexts = records.filter((r) => r.eventName === 'gen_ai.user.message').map((r) => extractTextFromContentBlocks(r.body?.content));
    const choiceTexts = records.filter((r) => r.eventName === 'gen_ai.choice').map((r) => extractTextFromContentBlocks(r.body?.message?.content));
    const assistantTexts = records.filter((r) => r.eventName === 'gen_ai.assistant.message').map((r) => extractTextFromContentBlocks(r.body?.content));
    return {
        userMessage: userTexts[userTexts.length - 1] || '',
        agentResponse: choiceTexts[choiceTexts.length - 1] || assistantTexts[assistantTexts.length - 1] || ''
    };
}

/** Resolves conversation content for one trace: prefers the last STRANDS_AGGREGATE record (child spans close, and log, before their parent, so the last one reflects the outermost span's whole-trace view). Falls back to GENAI_EVENT reconstruction otherwise. */
function resolveTraceContent(records) {
    const strandsAggregates = records.filter((r) => classifyRecord(r) === 'STRANDS_AGGREGATE');
    if (strandsAggregates.length > 0) return extractConversationContentFromStrandsAggregate(strandsAggregates[strandsAggregates.length - 1]);

    const genAiEvents = records.filter((r) => classifyRecord(r) === 'GENAI_EVENT');
    if (genAiEvents.length > 0) return extractConversationContentFromGenAiEvents(genAiEvents);

    return { userMessage: '', agentResponse: '' };
}

/**
 * Adapts one trace's resolved identity+content into the pair shape
 * discovery.js's createStandardMessage expects.
 *
 * harness.id and gen_ai.request.model only exist on the raw span record,
 * which this pipeline doesn't read (see logGroupReader.js). Both are instead
 * derived from data every content record carries: a runtime's service.name
 * gives its harness's name, and that harness's ID, name, role ARN, and
 * configured model are already known from discovery.
 *
 * harnessNameToResourceMap (not roleNameToResourceMap) is used for every
 * Harness-related lookup here because a Harness and the Runtime it
 * auto-provisions commonly share one execution role — a role-name-keyed
 * lookup can return the Runtime's data instead of the Harness's.
 */
function buildConversationPair(identity, content, logGroup, roleNameToResourceMap, harnessNameToResourceMap) {
    const runtimeId = identity.runtimeId || logGroup.runtimeId || '';
    let harnessId = identity.harnessId;
    let knownHarness = null;

    if (harnessNameToResourceMap) {
        if (harnessId) {
            knownHarness = Object.values(harnessNameToResourceMap).find((h) => h.resourceId === harnessId) || null;
        } else {
            const harnessName = extractHarnessNameFromServiceName(identity.serviceName);
            knownHarness = (harnessName && harnessNameToResourceMap[harnessName]) || null;
            if (knownHarness) harnessId = knownHarness.resourceId;
        }
    }

    let modelId = identity.modelId || knownHarness?.foundationModel;
    let logType = 'UNKNOWN';
    let resourceId = '';
    let resourceName = identity.serviceName || '';
    let executionRoleArn = '';

    if (harnessId) {
        logType = 'HARNESS';
        resourceId = harnessId;
        resourceName = knownHarness?.resourceName || resourceName;
        executionRoleArn = knownHarness?.executionRoleArn || '';
    } else if (runtimeId) {
        logType = 'RUNTIME';
        resourceId = runtimeId;
        const known = roleNameToResourceMap && Object.values(roleNameToResourceMap).find((r) => r.resourceType === 'RUNTIME' && r.resourceId === resourceId);
        resourceName = known?.resourceName || resourceName;
        executionRoleArn = known?.executionRoleArn || '';
        if (!modelId) modelId = known?.foundationModel;
    }

    return {
        timestamp: identity.startTimeUnixNano ? Math.floor(Number(identity.startTimeUnixNano) / 1e6) : Date.now(),
        requestId: identity.traceId || identity.spanId || '',
        modelId: modelId || 'unknown-model',
        harnessId: logType === 'HARNESS' ? resourceId : '',
        harnessRoleSuffix: '',
        runtimeId: logType === 'RUNTIME' ? resourceId : '',
        resourceName,
        executionRoleArn,
        arn: identity.resourceArn || '',
        logType,
        operation: 'AGENTCORE_TRACE',
        accountId: AWS_ACCOUNT_ID,
        region: AWS_REGION,
        inputTokenCount: 0,
        outputTokenCount: 0,
        userMessage: content.userMessage,
        agentResponse: content.agentResponse,
        traceData: { traceId: identity.traceId, sessionId: identity.sessionId }
    };
}

module.exports = {
    classifyRecord, parseLogRecord, resolveTraceIdentity, resolveTraceContent, buildConversationPair
};
