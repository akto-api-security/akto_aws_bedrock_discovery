/**
 * Synthetic HTTP hosts for AKTO mirroring. Collections group by host; gateways
 * already use each gateway's real hostname — agents/harnesses/runtimes get a
 * stable per-resource host derived from the agent name (with id disambiguation).
 */

const AGENTCORE_AGENT_HOST_SEGMENT = 'agent';

/**
 * @param {string} raw
 * @param {string} [fallback]
 */
function toDnsLabel(raw, fallback = 'agentcore') {
    let label = String(raw || '')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!label) label = fallback;
    return label.slice(0, 63);
}

/**
 * @param {{ name?: string, id?: string }} identity
 */
function agentMirrorHostLabel({ name, id }) {
    const fromName = toDnsLabel(name, '');
    const fromId = toDnsLabel(id, '');
    if (fromName.length >= 3 && fromId && fromName !== fromId) {
        const suffix = String(id).split('-').pop() || '';
        const short = toDnsLabel(suffix, '').slice(0, 12);
        if (short.length >= 4) {
            return toDnsLabel(`${fromName}-${short}`, fromId);
        }
    }
    return fromName || fromId || 'agentcore';
}

/**
 * @param {{ name?: string, id?: string }} identity
 * @param {string} region
 */
function agentCoreMirrorHost(identity, region) {
    const label = agentMirrorHostLabel(identity);
    const r = region || 'us-east-1';
    return `${label}.${AGENTCORE_AGENT_HOST_SEGMENT}.bedrock-agentcore.${r}.amazonaws.com`;
}

/** Classic Bedrock Runtime API mirror (direct model invoke, no agent resource). */
function bedrockRuntimeMirrorHost(region) {
    return `bedrock-runtime.${region || 'us-east-1'}.amazonaws.com`;
}

/**
 * @param {object} data — buildAgentMessage payload
 * @param {boolean} isConversation
 * @param {string} defaultRegion
 */
function resolveMirrorHost(data, isConversation, defaultRegion) {
    const region = isConversation ? (data.region || defaultRegion) : defaultRegion;

    if (isConversation) {
        switch (data.logType) {
            case 'HARNESS':
                return agentCoreMirrorHost({ name: data.botName || data.resourceName, id: data.harnessId }, region);
            case 'RUNTIME':
            case 'STANDALONE_RUNTIME':
                return agentCoreMirrorHost({ name: data.botName || data.resourceName, id: data.runtimeId || data.agentId }, region);
            case 'AGENT':
            case 'SERVICE_AGENT':
                return agentCoreMirrorHost({ name: data.botName || data.agentName, id: data.agentId }, region);
            default:
                if (data.botName || data.agentId || data.harnessId || data.runtimeId) {
                    return agentCoreMirrorHost({
                        name: data.botName || data.resourceName || data.agentName,
                        id: data.harnessId || data.runtimeId || data.agentId
                    }, region);
                }
                return bedrockRuntimeMirrorHost(region);
        }
    }

    switch (data.resourceType) {
        case 'HARNESS':
            return agentCoreMirrorHost({ name: data.harnessName, id: data.harnessId }, region);
        case 'RUNTIME':
        case 'STANDALONE_RUNTIME':
            return agentCoreMirrorHost({ name: data.runtimeName, id: data.runtimeId }, region);
        case 'AGENT':
            return agentCoreMirrorHost({ name: data.agentName || data.resourceName, id: data.agentId || data.resourceId }, region);
        default:
            return bedrockRuntimeMirrorHost(region);
    }
}

module.exports = {
    toDnsLabel,
    agentMirrorHostLabel,
    agentCoreMirrorHost,
    bedrockRuntimeMirrorHost,
    resolveMirrorHost,
    AGENTCORE_AGENT_HOST_SEGMENT
};
