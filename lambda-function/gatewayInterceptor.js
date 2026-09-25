/**
 * Attaches (and detaches) the AKTO interceptor Lambda on every AgentCore
 * Gateway it can find — no gateway IDs are ever supplied by the client.
 *
 * Three invariants shape everything here, because this module mutates live
 * client infrastructure:
 *
 *  1. Never break a gateway. Invoke permission is granted BEFORE attachment; if
 *     the grant fails we skip the gateway entirely rather than point it at a
 *     Lambda it cannot call.
 *  2. Never delete someone else's interceptor. AWS allows one interceptor per
 *     interception point, so a point already held by a non-AKTO Lambda is left
 *     alone and we take only what's free.
 *  3. Never update needlessly. UpdateGateway redeploys the gateway, so an
 *     already-correct gateway is skipped without an API call.
 *
 * Per-gateway failures are logged and skipped; one bad gateway never aborts the
 * sweep.
 */
const { UpdateGatewayCommand } = require('@aws-sdk/client-bedrock-agentcore-control');
const {
    AddPermissionCommand, RemovePermissionCommand,
    GetFunctionConfigurationCommand, UpdateFunctionConfigurationCommand
} = require('@aws-sdk/client-lambda');
const config = require('./config');
const {
    lambdaClient, INTERCEPTION_POINTS,
    INCLUDE_GATEWAY_IDS, EXCLUDE_GATEWAY_IDS, GATEWAY_NAME_MAP_MAX_BYTES
} = config;
const {
    listAllGateways, getGatewayDetail, buildHarnessGatewayMap, readAttachedInterceptors, buildGatewayProfile
} = require('./gatewayDiscovery');
const { buildGatewayDiscoveryMessage } = require('./gatewayMessageBuilder');
const {
    getGatewayManifest, updateGatewayManifest, fingerprintProfile, needsAnnouncement, buildManifestEntry
} = require('./gatewayManifest');
const { sendToDataIngestionService } = require('./aktoClient');
const { deriveGatewayName } = require('./gatewayNaming');

// The gateway hands us request headers so guardrails can see them; they're
// stripped of credentials before anything leaves for AKTO (interceptorPayload.js).
const INPUT_CONFIGURATION = { passRequestHeaders: true };

// A gateway mid-change rejects UpdateGateway, and a FAILED one shouldn't be
// touched at all — both are retried on the next sweep.
const ATTACHABLE_STATUS = 'READY';

/**
 * Fields UpdateGateway needs echoed back. It is a full-replace API: anything
 * omitted here is silently cleared on the client's gateway, so this list must
 * stay in sync with GetGatewayResponse.
 */
const PRESERVED_FIELDS = [
    'description', 'protocolType', 'protocolConfiguration', 'authorizerConfiguration',
    'kmsKeyArn', 'customTransformConfiguration', 'policyEngineConfiguration',
    'exceptionLevel', 'wafConfiguration'
];

/** Lambda statement IDs must be [A-Za-z0-9-_] and are capped at 100 chars. */
function statementId(prefix, gatewayId) {
    return `${prefix}-${gatewayId}`.replace(/[^A-Za-z0-9-_]/g, '-').slice(0, 100);
}

function isAlreadyExists(error) {
    return error?.name === 'ResourceConflictException';
}

function isMissing(error) {
    return error?.name === 'ResourceNotFoundException';
}

/**
 * Lets one gateway invoke the interceptor, via a resource-based policy on our
 * own function — deliberately not by editing the client's gateway role, which
 * we don't own.
 *
 * Two statements because the invoke can present either identity depending on
 * how AgentCore dispatches: the service principal (scoped to this gateway's ARN)
 * and the gateway's own execution role. Same-account resource-policy grants are
 * sufficient on their own, so no change to the client's IAM is needed.
 * Returns true only if the interceptor is definitely callable.
 */
async function ensureInvokePermission(interceptorArn, gateway) {
    const gatewayId = gateway.gatewayId;
    const grants = [
        { sid: statementId('akto-gw-svc', gatewayId), Principal: 'bedrock-agentcore.amazonaws.com', SourceArn: gateway.gatewayArn },
        ...(gateway.roleArn ? [{ sid: statementId('akto-gw-role', gatewayId), Principal: gateway.roleArn }] : [])
    ];

    let granted = 0;
    for (const grant of grants) {
        try {
            await lambdaClient.send(new AddPermissionCommand({
                FunctionName: interceptorArn,
                StatementId: grant.sid,
                Action: 'lambda:InvokeFunction',
                Principal: grant.Principal,
                ...(grant.SourceArn ? { SourceArn: grant.SourceArn } : {})
            }));
            granted++;
        } catch (error) {
            if (isAlreadyExists(error)) {
                granted++;  // already in the policy from a previous sweep
                continue;
            }
            console.error(`⚠️ Could not grant invoke permission (${grant.Principal}) on ${gatewayId}: ${error.message}`);
        }
    }
    return granted > 0;
}

/** Drops both statements for a gateway. Missing statements are not an error. */
async function removeInvokePermission(interceptorArn, gatewayId) {
    for (const prefix of ['akto-gw-svc', 'akto-gw-role']) {
        try {
            await lambdaClient.send(new RemovePermissionCommand({
                FunctionName: interceptorArn,
                StatementId: statementId(prefix, gatewayId)
            }));
        } catch (error) {
            if (!isMissing(error)) {
                console.error(`⚠️ Could not remove invoke permission ${prefix} for ${gatewayId}: ${error.message}`);
            }
        }
    }
}

/**
 * Decides what to do with one gateway without calling anything. Split out from
 * the mutation so dry runs and tests exercise the real decision logic.
 */
function planAttachment(gateway, interceptorArn) {
    if (gateway.status !== ATTACHABLE_STATUS) {
        return { action: 'skip-not-ready', reason: `status=${gateway.status}` };
    }
    if (!gateway.name || !gateway.roleArn || !gateway.authorizerType) {
        return {
            action: 'skip-incomplete',
            reason: `missing required field(s) for UpdateGateway: name=${gateway.name}, roleArn=${gateway.roleArn}, authorizerType=${gateway.authorizerType}`
        };
    }

    const existing = gateway.interceptorConfigurations || [];
    const ours = existing.filter((c) => c?.interceptor?.lambda?.arn === interceptorArn);
    const others = existing.filter((c) => c?.interceptor?.lambda?.arn !== interceptorArn);

    const takenByOthers = new Set();
    for (const config of others) {
        for (const point of config?.interceptionPoints || []) takenByOthers.add(point);
    }

    const freePoints = INTERCEPTION_POINTS.filter((point) => !takenByOthers.has(point));
    if (freePoints.length === 0) {
        const { arns } = readAttachedInterceptors({ interceptorConfigurations: others });
        return {
            action: 'skip-conflict',
            reason: `REQUEST and RESPONSE are both held by another interceptor (${arns.join(',') || 'unknown'}) — leaving it untouched`
        };
    }

    const currentPoints = new Set();
    for (const config of ours) {
        for (const point of config?.interceptionPoints || []) currentPoints.add(point);
    }
    const alreadyCorrect = currentPoints.size === freePoints.length && freePoints.every((point) => currentPoints.has(point));
    if (alreadyCorrect) {
        return { action: 'already-attached', points: freePoints, partial: freePoints.length < INTERCEPTION_POINTS.length };
    }

    return {
        action: 'attach',
        points: freePoints,
        partial: freePoints.length < INTERCEPTION_POINTS.length,
        // Ours are replaced by one config covering every free point; theirs ride along untouched.
        interceptorConfigurations: [
            { interceptor: { lambda: { arn: interceptorArn } }, interceptionPoints: freePoints, inputConfiguration: INPUT_CONFIGURATION },
            ...others
        ]
    };
}

/** Echoes the gateway's whole config back with a new interceptor list. */
function buildUpdateParams(gateway, interceptorConfigurations) {
    const params = {
        gatewayIdentifier: gateway.gatewayId,
        name: gateway.name,
        roleArn: gateway.roleArn,
        authorizerType: gateway.authorizerType
    };
    // AWS rejects an empty list ("Member must have length greater than or equal
    // to 1"), so clearing every interceptor means omitting the field entirely —
    // which this full-replace API treats as "no interceptors".
    if (interceptorConfigurations && interceptorConfigurations.length) {
        params.interceptorConfigurations = interceptorConfigurations;
    }
    for (const field of PRESERVED_FIELDS) {
        if (gateway[field] !== undefined && gateway[field] !== null) params[field] = gateway[field];
    }
    return params;
}

/**
 * Sends the UpdateGateway, with one fallback for protocolType.
 *
 * Our two reference implementations disagree about it: the shell deployer omits
 * it as "immutable on an existing gateway", while the CloudFormation one sends it
 * back. Both readings are defensible and the failure modes are asymmetric —
 * omitting a field from a full-replace API risks clearing it, sending an
 * immutable one risks a rejection — so rather than pick, send it and retry
 * without it if the API objects. Either way the gateway ends up correct.
 */
async function sendGatewayUpdate(gateway, interceptorConfigurations) {
    const params = buildUpdateParams(gateway, interceptorConfigurations);
    try {
        return await config.bedrockAgentCoreControlClient.send(new UpdateGatewayCommand(params));
    } catch (error) {
        // Only when the API actually complains about protocolType — a bare
        // ValidationException is far more likely to be something else, and
        // retrying on it produces a misleading log line about the wrong field.
        const rejectsProtocol = 'protocolType' in params && /protocol/i.test(error?.message || '');
        if (!rejectsProtocol) throw error;

        console.warn(`⚠️ ${gateway.gatewayId}: UpdateGateway rejected protocolType (${error.message}) — retrying without it`);
        const { protocolType, ...withoutProtocol } = params;
        return config.bedrockAgentCoreControlClient.send(new UpdateGatewayCommand(withoutProtocol));
    }
}

/**
 * Announces protected gateways to AKTO as discovered inventory, the same way agents
 * and harnesses are announced, and checkpoints what was sent.
 *
 * Runs after the attach sweep rather than inside it: a slow or unreachable AKTO must
 * never delay or fail attachment. Only gateways we actually protect are announced.
 *
 * Re-announces when a gateway's fingerprint moves (new target, changed authorizer,
 * interception points gained or lost) so the inventory doesn't go stale, and skips
 * everything unchanged so a 10-minute sweep stays quiet.
 */
async function announceGateways(gateways, { harnessMap = {}, dryRun = false } = {}) {
    const summary = { announced: 0, unchanged: 0, failed: 0 };
    if (gateways.length === 0) return summary;

    const manifest = await getGatewayManifest();
    const discovered = { ...(manifest.discoveredGateways || {}) };
    const messages = [];
    const pending = [];

    for (const gateway of gateways) {
        try {
            const profile = await buildGatewayProfile(gateway, { harnessMap });
            const fingerprint = fingerprintProfile(profile);
            const previous = discovered[profile.gatewayId];
            const { announce, reason } = needsAnnouncement(previous, fingerprint);

            if (!announce) {
                summary.unchanged++;
                continue;
            }
            console.log(`🔔 ${profile.gatewayId} (${profile.name}): ${reason} — will announce to AKTO as ${profile.host}`);
            if (dryRun) {
                summary.announced++;
                continue;
            }
            messages.push(buildGatewayDiscoveryMessage(profile));
            pending.push({ profile, fingerprint, previous });
        } catch (error) {
            summary.failed++;
            console.error(`❌ ${gateway.gatewayId}: could not build discovery profile — ${error.message}`);
        }
    }

    if (messages.length === 0) {
        if (summary.unchanged > 0) console.log(`✅ ${summary.unchanged} gateway(s) already announced and unchanged — nothing to send`);
        return summary;
    }

    try {
        // Checkpoint only after AKTO accepts, so a failed send is retried next sweep
        // rather than being silently marked as announced.
        await sendToDataIngestionService(messages);
        for (const { profile, fingerprint, previous } of pending) {
            discovered[profile.gatewayId] = buildManifestEntry(profile, fingerprint, previous);
        }
        summary.announced += pending.length;
        await updateGatewayManifest(discovered);
        console.log(`🎉 Gateway discovery: ${summary.announced} announced, ${summary.unchanged} unchanged, ${summary.failed} failed`);
    } catch (error) {
        summary.failed += pending.length;
        console.error(`❌ Gateway discovery send failed (will retry next sweep, nothing checkpointed): ${error.message}`);
    }
    return summary;
}

/**
 * Publishes a compact gatewayId → name map onto the interceptor function's
 * environment, so live traffic can be tagged with the gateway *name* without the
 * interceptor making an AWS call. It resolves its own gateway ID from the Host
 * header; only the name needs supplying.
 *
 * Merges into the existing environment rather than replacing it — UpdateFunctionConfiguration
 * overwrites the whole variable set, and blanking the AKTO endpoint would silently
 * disable guardrails. Skips the write entirely when the map hasn't changed.
 */
async function publishGatewayNameMap(interceptorArn, gateways) {
    if (!interceptorArn || gateways.length === 0) return false;

    // Only gateways whose name the interceptor cannot work out for itself. For the
    // standard "<name>-<suffix>" ID form that's none, so this map stays empty no
    // matter how many gateways the account has — which is what keeps Lambda's 4KB
    // environment limit from becoming a ceiling on gateway count.
    const exceptions = gateways.filter((g) => g.gatewayId && g.name && g.name !== deriveGatewayName(g.gatewayId));

    // Pack by real byte cost rather than a guessed entry count: a handful of very
    // long names would otherwise sail past any fixed limit and fail the write.
    const map = {};
    let dropped = 0;
    for (const gateway of exceptions) {
        const candidate = JSON.stringify({ ...map, [gateway.gatewayId]: gateway.name });
        if (Buffer.byteLength(candidate, 'utf8') > GATEWAY_NAME_MAP_MAX_BYTES) { dropped++; continue; }
        map[gateway.gatewayId] = gateway.name;
    }
    if (dropped > 0) {
        console.warn(`⚠️ ${dropped} gateway name(s) did not fit the environment budget — those gateways will be tagged with their derived name or ID instead`);
    }
    if (exceptions.length > 0) {
        console.log(`ℹ️ ${exceptions.length} gateway name(s) can't be derived from their ID and are published explicitly; the other ${gateways.length - exceptions.length} derive theirs`);
    }
    const desired = JSON.stringify(map);

    try {
        const current = await lambdaClient.send(new GetFunctionConfigurationCommand({ FunctionName: interceptorArn }));
        const variables = { ...(current.Environment?.Variables || {}) };
        if (variables.GATEWAY_NAME_MAP === desired) return false;

        await lambdaClient.send(new UpdateFunctionConfigurationCommand({
            FunctionName: interceptorArn,
            Environment: { Variables: { ...variables, GATEWAY_NAME_MAP: desired } }
        }));
        console.log(`🏷️ Published ${Object.keys(map).length} gateway name override(s) to the interceptor for traffic tagging`);
        return true;
    } catch (error) {
        // Non-fatal: without the map, live traffic is tagged with the gateway ID.
        console.error(`⚠️ Could not publish gateway names to the interceptor (traffic will be tagged with gateway IDs): ${error.message}`);
        return false;
    }
}

/**
 * Sweeps every gateway in the region and brings its interceptor config in line.
 * Safe to run repeatedly — that's the point, since it's what picks up gateways
 * created after deployment and repairs manual removals.
 */
async function reconcileInterceptorAttachments({ interceptorArn, timeLeft, timeMarginMs = 30000, dryRun = false } = {}) {
    const summary = {
        gatewaysFound: 0, attached: 0, alreadyAttached: 0, partiallyAttached: 0,
        skippedFiltered: 0, skippedNotReady: 0, skippedConflict: 0, skippedNoPermission: 0,
        failed: 0, deferred: 0, announced: 0, announceUnchanged: 0, announceFailed: 0, dryRun
    };
    // Gateways we end up protecting — announced to AKTO after the sweep. Includes
    // already-attached ones so existing deployments are backfilled on upgrade.
    const protectedGateways = [];

    if (!interceptorArn) {
        console.log('⏭️ No INTERCEPTOR_LAMBDA_ARN configured — gateway interception disabled, nothing to do');
        return summary;
    }

    const gateways = await listAllGateways();
    summary.gatewaysFound = gateways.length;

    // The common case for a discovery-only account: no gateways, so no work at
    // all — no GetGateway calls, no permissions, no updates.
    if (gateways.length === 0) {
        console.log('✅ No AgentCore gateways found in this region — skipping interceptor attachment entirely');
        return summary;
    }

    console.log(`🔎 ${gateways.length} gateway(s) found${dryRun ? ' — DRY RUN, nothing will be modified' : ''}`);
    const harnessMap = await buildHarnessGatewayMap();

    for (const item of gateways) {
        const gatewayId = item.gatewayId;
        if (!gatewayId) continue;

        if (timeLeft && timeLeft() < timeMarginMs) {
            summary.deferred = gateways.length - (summary.attached + summary.alreadyAttached + summary.skippedFiltered
                + summary.skippedNotReady + summary.skippedConflict + summary.skippedNoPermission + summary.failed);
            console.warn(`⏱️ ${timeLeft()}ms left — stopping gateway sweep, ${summary.deferred} gateway(s) deferred to the next run`);
            break;
        }

        if (INCLUDE_GATEWAY_IDS.length && !INCLUDE_GATEWAY_IDS.includes(gatewayId)) {
            summary.skippedFiltered++;
            continue;
        }
        if (EXCLUDE_GATEWAY_IDS.includes(gatewayId)) {
            console.log(`⏭️ ${gatewayId}: excluded by EXCLUDE_GATEWAY_IDS`);
            summary.skippedFiltered++;
            continue;
        }

        try {
            // Always uncached: another sweep or the client may have changed this
            // gateway since, and a stale read here means a bad UpdateGateway.
            const gateway = await getGatewayDetail(gatewayId, { useCache: false });
            if (!gateway) {
                summary.failed++;
                continue;
            }

            const callers = harnessMap[gatewayId] || [];
            const callerLabel = callers.length
                ? `used by harness ${callers.map((c) => c.harnessName).join(', ')}`
                : 'no harness link found (may still be called by a runtime or external MCP client)';

            const plan = planAttachment(gateway, interceptorArn);

            if (plan.action === 'skip-not-ready') {
                console.log(`⏭️ ${gatewayId}: ${plan.reason} — will retry next sweep`);
                summary.skippedNotReady++;
                continue;
            }
            if (plan.action === 'skip-incomplete') {
                console.error(`❌ ${gatewayId}: ${plan.reason}`);
                summary.failed++;
                continue;
            }
            if (plan.action === 'skip-conflict') {
                console.warn(`⚠️ ${gatewayId} (${gateway.name}): ${plan.reason} — ${callerLabel}`);
                summary.skippedConflict++;
                continue;
            }
            if (plan.action === 'already-attached') {
                console.log(`✅ ${gatewayId} (${gateway.name}): already attached on ${plan.points.join('+')}${plan.partial ? ' (partial — other points held by another interceptor)' : ''} — no update needed`);
                summary.alreadyAttached++;
                if (plan.partial) summary.partiallyAttached++;
                protectedGateways.push(gateway);
                continue;
            }

            if (dryRun) {
                console.log(`🧪 ${gatewayId} (${gateway.name}): WOULD attach on ${plan.points.join('+')} — ${callerLabel}`);
                summary.attached++;
                if (plan.partial) summary.partiallyAttached++;
                continue;
            }

            // Permission first: a gateway pointed at a Lambda it can't invoke is
            // worse than an unguarded gateway.
            if (!await ensureInvokePermission(interceptorArn, gateway)) {
                console.error(`❌ ${gatewayId}: could not grant invoke permission — NOT attaching (gateway left untouched)`);
                summary.skippedNoPermission++;
                continue;
            }

            await sendGatewayUpdate(gateway, plan.interceptorConfigurations);
            console.log(`✅ ${gatewayId} (${gateway.name}): interceptor attached on ${plan.points.join('+')}${plan.partial ? ' (partial)' : ''} — ${callerLabel}`);
            summary.attached++;
            if (plan.partial) summary.partiallyAttached++;
            // Announce with the config we just wrote, so the discovery message reports
            // the interceptor as attached rather than the pre-attach state we read.
            protectedGateways.push({ ...gateway, interceptorConfigurations: plan.interceptorConfigurations });
        } catch (error) {
            console.error(`❌ ${gatewayId}: attachment failed, skipping — ${error.message}`);
            summary.failed++;
        }
    }

    // Names first, so live traffic can be tagged with them; then the discovery hits.
    if (!dryRun) await publishGatewayNameMap(interceptorArn, protectedGateways);

    const discovery = await announceGateways(protectedGateways, { harnessMap, dryRun });
    summary.announced = discovery.announced;
    summary.announceUnchanged = discovery.unchanged;
    summary.announceFailed = discovery.failed;

    console.log(`🎉 Gateway sweep done: ${JSON.stringify(summary)}`);
    return summary;
}

/**
 * Removes our interceptor from every gateway and drops the invoke permissions.
 * Runs on stack delete (and when interception is switched off), so the client
 * is never left with gateways pointing at a Lambda that no longer exists.
 */
async function detachAllInterceptors({ interceptorArn, dryRun = false } = {}) {
    const summary = { gatewaysFound: 0, detached: 0, notAttached: 0, failed: 0, dryRun };

    if (!interceptorArn) {
        console.log('⏭️ No interceptor ARN provided — nothing to detach');
        return summary;
    }

    const gateways = await listAllGateways();
    summary.gatewaysFound = gateways.length;

    for (const item of gateways) {
        const gatewayId = item.gatewayId;
        if (!gatewayId) continue;
        try {
            const gateway = await getGatewayDetail(gatewayId, { useCache: false });
            if (!gateway) {
                summary.failed++;
                continue;
            }

            const existing = gateway.interceptorConfigurations || [];
            const remaining = existing.filter((c) => c?.interceptor?.lambda?.arn !== interceptorArn);
            if (remaining.length === existing.length) {
                summary.notAttached++;
                // Still clear any permission left behind by an earlier failed attach.
                if (!dryRun) await removeInvokePermission(interceptorArn, gatewayId);
                continue;
            }

            if (dryRun) {
                console.log(`🧪 ${gatewayId}: WOULD detach AKTO interceptor`);
                summary.detached++;
                continue;
            }

            if (gateway.status !== ATTACHABLE_STATUS) {
                console.warn(`⚠️ ${gatewayId}: status=${gateway.status}, cannot detach right now — leaving as-is`);
                summary.failed++;
                continue;
            }

            await sendGatewayUpdate(gateway, remaining);
            await removeInvokePermission(interceptorArn, gatewayId);
            console.log(`🧹 ${gatewayId} (${gateway.name}): AKTO interceptor detached, ${remaining.length} other config(s) preserved`);
            summary.detached++;
        } catch (error) {
            console.error(`❌ ${gatewayId}: detach failed — ${error.message}`);
            summary.failed++;
        }
    }

    console.log(`🎉 Detach sweep done: ${JSON.stringify(summary)}`);
    return summary;
}

module.exports = {
    reconcileInterceptorAttachments, detachAllInterceptors, planAttachment,
    announceGateways, publishGatewayNameMap,
    buildUpdateParams, ensureInvokePermission, removeInvokePermission, statementId
};
