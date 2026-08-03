/**
 * Keeps the AKTO interceptor attached to every AgentCore Gateway in the region.
 *
 * Its own Lambda, separate from both the discovery processor (index.js) and the
 * interceptor (interceptor.js), for three reasons: the gateway-mutating IAM
 * permissions stay off the processor's role, attachment never competes with
 * discovery for its time budget, and disabling the whole feature is just a matter
 * of not creating this function.
 *
 * Three entry paths:
 *   CFN custom resource  — attach on stack create/update, detach on delete
 *   EventBridge schedule — re-reconcile, picking up gateways created later
 *   manual invoke        — {"action": "detach-interceptors"} as an escape hatch
 */
const { INTERCEPTOR_LAMBDA_ARN, INTERCEPTOR_DRY_RUN } = require('./config');
const { reconcileInterceptorAttachments, detachAllInterceptors } = require('./gatewayInterceptor');
const { sendCfnResponse, SUCCESS } = require('./cfnResponse');

/** Stable across updates — a changing physical ID makes CFN delete the "old" resource, undoing the attach. */
function physicalIdFor(event) {
    return event.PhysicalResourceId || `akto-gateway-interceptor-${event.LogicalResourceId}`;
}

/**
 * CFN's response Data must be flat name/value pairs, and a template !GetAtt on a
 * key that isn't there fails the stack — so every value is stringified and
 * Summary is guaranteed present on every path, including errors.
 */
function toResponseData(summary, reason) {
    const data = { Summary: reason || 'no summary' };
    for (const [key, value] of Object.entries(summary || {})) {
        data[key] = String(value);
    }
    return data;
}

/**
 * Deploy-time and teardown-time attachment.
 *
 * Always responds SUCCESS. Interception is an enhancement layered on top of
 * discovery, so a gateway that can't be attached must not roll back (or block
 * the deletion of) the client's whole stack — failures are logged loudly and
 * reported in the response Data instead.
 */
async function handleCustomResource(event, context) {
    const physicalResourceId = physicalIdFor(event);
    let summary = {};
    let reason = '';

    try {
        // On Delete, CFN replays the last-known properties — the env var may
        // already be gone with the function that used to define it.
        const interceptorArn = event.ResourceProperties?.InterceptorLambdaArn || INTERCEPTOR_LAMBDA_ARN;
        console.log(`🚀 CloudFormation ${event.RequestType} — interceptor ARN: ${interceptorArn || '(none)'}`);

        if (event.RequestType === 'Delete') {
            summary = await detachAllInterceptors({ interceptorArn });
            reason = `Detached from ${summary.detached} gateway(s)`;
        } else {
            summary = await reconcileInterceptorAttachments({
                interceptorArn,
                timeLeft: () => context.getRemainingTimeInMillis(),
                dryRun: INTERCEPTOR_DRY_RUN
            });
            reason = `Attached to ${summary.attached} gateway(s), ${summary.alreadyAttached} already attached, ${summary.gatewaysFound} found`;
        }

        if (summary.failed || summary.skippedNoPermission || summary.skippedConflict) {
            console.warn(`⚠️ Attachment completed with issues — failed=${summary.failed || 0}, noPermission=${summary.skippedNoPermission || 0}, conflict=${summary.skippedConflict || 0}. Stack is NOT failed; see the log lines above for the affected gateways.`);
        }
    } catch (error) {
        console.error(`❌ Custom resource error (reporting SUCCESS so the stack is not blocked): ${error.message}`);
        console.error(error.stack);
        reason = `Completed with error: ${error.message}`;
        summary = { error: error.message };
    } finally {
        // Unconditional: a missing response strands the stack for an hour.
        await sendCfnResponse(event, { status: SUCCESS, reason, data: toResponseData(summary, reason), physicalResourceId });
    }

    return { statusCode: 200, body: JSON.stringify(summary) };
}

exports.handler = async (event, context) => {
    // CFN custom-resource invocation.
    if (event?.RequestType && event?.ResponseURL) {
        return handleCustomResource(event, context);
    }

    // Manual teardown without touching the stack.
    if (event?.action === 'detach-interceptors') {
        console.log('🧹 Manual detach requested');
        const summary = await detachAllInterceptors({
            interceptorArn: event.interceptorLambdaArn || INTERCEPTOR_LAMBDA_ARN,
            dryRun: event.dryRun === true || INTERCEPTOR_DRY_RUN
        });
        return { statusCode: 200, body: JSON.stringify(summary) };
    }

    // Scheduled reconcile. event.dryRun lets an operator preview the attach
    // decisions with a one-off manual invoke — no env var or stack update needed:
    //   aws lambda invoke --function-name <attacher> --payload '{"dryRun":true}' out.json
    console.log(`🚀 AKTO gateway interceptor reconcile started | Event: ${event?.source || 'manual'} | Time budget: ${context.getRemainingTimeInMillis()}ms`);
    try {
        const summary = await reconcileInterceptorAttachments({
            interceptorArn: INTERCEPTOR_LAMBDA_ARN,
            timeLeft: () => context.getRemainingTimeInMillis(),
            dryRun: event?.dryRun === true || INTERCEPTOR_DRY_RUN
        });
        return { statusCode: 200, body: JSON.stringify(summary) };
    } catch (error) {
        console.error(`❌ Reconcile failed: ${error.message}`);
        console.error(error.stack);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
