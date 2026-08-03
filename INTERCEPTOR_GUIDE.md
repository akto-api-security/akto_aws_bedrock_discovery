# AgentCore Gateway Interception

Real-time AKTO guardrails on AgentCore Gateway MCP traffic, layered on top of the
existing discovery pipeline. Gateways are **discovered automatically** — the client
is never asked for gateway IDs.

## What gets deployed

`client-aws-cf-template.yaml` creates three Lambdas from one zip:

| Function | Handler | Trigger | Sizing |
|---|---|---|---|
| `akto-bedrock-log-processor-cf-<acct>` | `index.handler` | EventBridge `rate(10 minutes)` | 900s / 1024MB |
| `akto-bedrock-interceptor-cf-<acct>` | `interceptor.handler` | the gateways themselves | 10s / 256MB |
| `akto-bedrock-gw-attacher-cf-<acct>` | `gatewayAttacher.handler` | CFN custom resource + `rate(15 minutes)` | 300s / 512MB |

The discovery processor is untouched by this feature — it gained no permissions
and no code changes. The interceptor sits on the synchronous path of every guarded
tool call, so it deliberately loads **no AWS SDK at all** (`interceptorConfig.js`
exists instead of `config.js` for exactly this reason) and only talks to AKTO
over HTTPS.

## Turning it off

`EnableGatewayInterception=false` gates every interception resource behind a
CloudFormation condition. Nothing is created, no gateway is ever read or written,
and the stack is exactly the discovery-only deployment.

Flipping an existing stack from `true` to `false` cleanly **detaches** first: CFN
deletes the custom resource, which fires a `Delete` at the attacher while it's
still alive, and it strips AKTO's interceptor from every gateway and drops the
invoke permissions.

Three ways to stop, in increasing severity:

| Goal | Action | Effect |
|---|---|---|
| Freeze attachment, keep what's attached | Disable `akto-bedrock-gw-attacher-schedule-cf-<acct>` in EventBridge | No further sweeps; existing interception keeps working |
| Remove interception, keep the stack | Invoke the attacher with `{"action": "detach-interceptors"}` | Detaches everywhere; next scheduled sweep re-attaches |
| Remove interception permanently | Stack update with `EnableGatewayInterception=false` | Detaches and deletes the interceptor + attacher |

## How gateways are found

`ListGateways` over the region, then one `GetGateway` per gateway (summaries omit
`roleArn` and `interceptorConfigurations`, both of which attachment needs).

The attacher also builds a harness→gateway map from
`harness.tools[].config.agentCoreGateway.gatewayArn` and logs which agents sit
behind each gateway. This is **reporting only, never a filter**: a gateway can
also be called by a standalone runtime or an external MCP client, neither of which
leaves a control-plane link, so absence from the map does not mean "unused".

**No gateways in the account?** The sweep logs one line and returns — no
`GetGateway` calls, no permission grants, no updates. Nothing to configure.

## Per-gateway decisions

Every sweep re-derives the decision from live state (`planAttachment`), so it is
safe to run repeatedly and self-heals manual changes.

| Situation | Action |
|---|---|
| No interceptor attached | Attach on `REQUEST` + `RESPONSE` |
| AKTO already on both points | **Skip — no `UpdateGateway`** (it would redeploy the gateway) |
| Another Lambda holds one point | Attach on the free point only, preserving theirs (partial) |
| Another Lambda holds both points | **Skip and log loudly** — never deletes a client's interceptor |
| AKTO on one point, other now free | Re-attach across both |
| Status is not `READY` | Skip, retry next sweep |
| `name` / `roleArn` / `authorizerType` missing | Skip — refuse a partial `UpdateGateway` |

AWS allows only one interceptor configuration per interception point, which is why
a fully-occupied gateway is skipped rather than taken over. When that happens the
gateway shows `interceptor-attached: false` in its discovery tags, so it surfaces
in AKTO rather than only in CloudWatch.

### Two safety properties worth knowing

**`UpdateGateway` is full-replace.** `buildUpdateParams` echoes back
`description`, `protocolType`, `protocolConfiguration`, `authorizerConfiguration`,
`kmsKeyArn`, `customTransformConfiguration`, `policyEngineConfiguration`,
`exceptionLevel`, and `wafConfiguration`. Anything omitted would be silently
cleared on the client's gateway — if AWS adds a field to `GetGatewayResponse`,
add it to `PRESERVED_FIELDS`.

**Invoke permission is granted before attachment, and a failure aborts that
gateway.** A gateway pointed at a Lambda it cannot invoke is worse than an
unguarded gateway, so if `lambda:AddPermission` fails the gateway is left
untouched. The grant is a resource-based policy on AKTO's own function — two
statements (`akto-gw-svc-<id>` for the service principal, scoped to that gateway's
ARN, and `akto-gw-role-<id>` for the gateway's execution role). **The client's
gateway IAM role is never modified.**

## Guardrail behaviour on traffic

Only `tools/call` is guarded (`GUARDED_METHODS`, overridable by env var);
`initialize`, `tools/list`, and notifications pass straight through.

- **REQUEST leg** → `POST <akto>/api/http-proxy?guardrails=true&ingest_data=true`
- **RESPONSE leg** → `POST <akto>/api/http-proxy?response_guardrails=true` (no
  `ingest_data`, so the exchange isn't recorded twice)

Verdicts: blocked → JSON-RPC error `-32000` (403; a blocked *streaming* response
returns 200, since the status is already committed). `Modified` → the rewritten
`params.arguments` (request) or result (response) is substituted.
`behaviour=warn|alert` is recorded centrally but **does not block**, which is how a
policy is rolled out in monitor mode.

**It fails open, always.** Timeout (5s default), connection refused, HTTP 500,
malformed verdict, missing endpoint, or an outright bug in the interceptor all
result in the traffic passing through untouched. Credential headers
(`authorization`, `cookie`, `x-api-key`, `x-amz-security-token`, `set-cookie`) are
stripped before anything is sent to AKTO.

## Rollout

1. Upload the zip to `s3://lambda-code-akto-<region>/v1.1/akto-bedrock-processor.zip`
   **before** any client deploys — `LambdaCodeVersion` now defaults to `v1.1`, and
   interception requires v1.1 or later.
2. Deploy with `InterceptorDryRun=true` first. The attacher logs
   `🧪 <gatewayId>: WOULD attach on REQUEST+RESPONSE` per gateway and changes
   nothing. Confirm the gateway list looks right.
3. Optionally stage with `IncludeGatewayIds=<one test gateway>`, verify a real
   `tools/call` blocks and allows as expected, then clear the filter.
4. Set `InterceptorDryRun=false` for the full sweep.

Useful parameters: `IncludeGatewayIds` (blank = all), `ExcludeGatewayIds`,
`GatewayAttacherSchedule`, `AktoHttpProxyEndpoint` (blank = derived from
`DataIngestionEndpoint`'s origin as `<origin>/api/http-proxy`).

## Operational notes

- **The deploy-time attachment never fails the stack.** The custom resource always
  reports SUCCESS — interception is an enhancement over discovery, so a gateway
  that can't be attached must not roll back (or block the deletion of) the client's
  whole stack. Per-gateway outcomes are in the attacher's CloudWatch logs, and the
  `GatewayAttachmentResult` stack output carries the summary line.
- **Where to look:** `/aws/lambda/akto-bedrock-gw-attacher-cf-<acct>` for
  attachment decisions, `/aws/lambda/akto-bedrock-interceptor-cf-<acct>` for
  per-call guardrail verdicts.
- **Concurrency.** The interceptor has no reserved concurrency, so it draws on the
  account pool. If the account is near its concurrency ceiling, consider reserving
  some for the interceptor — a throttled interceptor is the one failure mode this
  design can't turn into a fail-open, since the invoke never reaches our code.
- **A sweep briefly redeploys a gateway** when it actually changes something. That
  is why already-correct gateways are skipped without an API call, and why the
  sweep is 15-minutely rather than continuous.
