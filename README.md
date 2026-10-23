# AKTO AWS Bedrock Discovery

Discovers AI agents running on AWS Bedrock in a client's account, sends their
conversations to AKTO for API discovery and security analysis, and optionally applies
AKTO guardrails in real time to AgentCore Gateway MCP traffic.

Everything runs inside the client's own AWS account, deployed from one CloudFormation
template. It needs no inbound access: the Lambdas only make outbound HTTPS calls to the
client's AKTO instance.

| Doc | For |
|---|---|
| [README.md](README.md) | What this project is and how it works (this file) |
| [CLIENT_DEPLOYMENT.md](CLIENT_DEPLOYMENT.md) | Clients: deploying and operating the CloudFormation stack |
| [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md) | AKTO developers: making a change, testing it and releasing it |

It comes in two forms, built from the same code:

| | Single account | Organization (StackSet) |
|---|---|---|
| Template | `cloudformation/templates/client-aws-cf-template.yaml` | `cloudformation/stackset/client-aws-cf-stackset-template.yaml` |
| Deployed | One stack per account and region | Once, from the management account, to OUs and regions |
| Logs bucket | Parameter | Read from each account's Bedrock logging config (optionally created) |
| Checkpoints | `<markers-bucket>/akto/markers/` in the account | Central bucket, `<account>/<region>/` |
| Code / updates | `unified_bedrock/` | `unified_bedrock_stackset/` |
| Lambda switch | `DEPLOYMENT_MODE` unset (`single`) | `DEPLOYMENT_MODE=stackset` |

## What it does

One zip, three handlers, plus a small self-updater.

```
                       ┌──────────────────────────────────────────────┐
 Bedrock model         │  Discovery processor  (index.handler)        │
 invocation logs (S3) ─┤   • Bedrock Agent Classic   ← S3 logs        │
                       │   • AgentCore Harness/Runtime ← CW traces    ├──► AKTO
 AgentCore traces     ─┤   runs every 10 min, checkpoints in S3       │    /api/ingestData
 (CloudWatch Logs)     └──────────────────────────────────────────────┘

                       ┌──────────────────────────────────────────────┐
 AgentCore Gateways ◄──┤  Gateway attacher  (gatewayAttacher.handler) │
                       │   finds every gateway, reports it to AKTO,   ├──► AKTO
                       │   attaches the interceptor                   │
                       └──────────────────────────────────────────────┘

 MCP tools/call ──────►  Interceptor  (interceptor.handler)  ─────────────► AKTO
                         block / redact / monitor, fails open               /api/http-proxy

 Every 15 min: updater reads unified_bedrock/versions.json and moves all three
 Lambdas to the build their channel names.
```

### 1. Discovery processor

Runs every 10 minutes and has two independent pipelines. Each pipeline keeps its own
checkpoint (manifest), so one never blocks the other.

| Pipeline | Source | Manifest |
|---|---|---|
| Bedrock Agent Classic | Bedrock model invocation logs in S3 (`LogsBucketName`/`LogsPrefix`) | `akto/markers/bedrock-logs/manifest.json` |
| AgentCore Harness/Runtime | CloudWatch observability traces (`RuntimeLogGroupPrefix`) | `akto/markers/agentcore-tracing/manifest.json` |

Each run:
- reads only data newer than its checkpoint (the first run goes back 3 days)
- extracts the final exchange of each conversation
- resolves which agent it belongs to, from the caller's IAM role or session name
- sends it to AKTO, then moves the checkpoint forward

A message AKTO permanently refuses is quarantined after retries, so it can't stall the
backlog. The AgentCore pipeline does nothing unless the client has enabled CloudWatch
Transaction Search.

### 2. Gateway interception (optional, `EnableGatewayInterception`)

- **Attacher**: runs at deploy time (as a CloudFormation custom resource) and then on a
  schedule. It lists every AgentCore Gateway in the region; the client never supplies
  gateway IDs. It reports each gateway to AKTO and attaches the interceptor on REQUEST
  and RESPONSE. It never removes a client's own interceptor: if both interception points
  are already taken it skips the gateway and logs it. It never modifies the gateway's IAM
  role; it only grants the gateway permission to invoke AKTO's interceptor. Gateways that
  are already correct are skipped without an API call, because `UpdateGateway`
  redeploys the gateway.
- **Interceptor**: guards only `tools/call`. The REQUEST leg goes to
  `/api/http-proxy?guardrails=true&ingest_data=true` and the RESPONSE leg to
  `?response_guardrails=true`. A blocked call returns JSON-RPC error `-32000`. **It always
  fails open**: on a timeout (5s), an error or a malformed verdict, traffic passes
  through unchanged. Credential headers are stripped before anything is sent to AKTO.
  The interceptor loads no AWS SDK (`interceptorConfig.js`), to keep the hot path fast.

`UpdateGateway` replaces the whole gateway configuration. The attacher echoes back every
field listed in `PRESERVED_FIELDS` (`gatewayInterceptor.js`), because any field left out
is silently cleared on the client's gateway.

### 3. Updater

This is an inline Lambda in the template. Every 15 minutes it reads
`s3://lambda-code-akto-<region>/unified_bedrock/versions.json`, looks up its channel
(`stable` for clients), and runs `UpdateFunctionCode` on all three Lambdas if they are
on a different build. The current build is recorded in the `akto:code-version` tag. So
**releasing a version means publishing a zip and moving a pointer**; clients never
redeploy. See [DEVELOPER_GUIDE.md](DEVELOPER_GUIDE.md).

## Repository layout

```
lambda-function/                  the Lambda code (one zip, three handlers)
  index.js                        discovery processor entry point
  discovery.js s3Logs.js extractors.js messageBuilder.js manifest.js
                                  Bedrock Agent Classic pipeline (S3 logs)
  traceDiscovery.js traceParser.js logGroupReader.js traceMessageBuilder.js traceManifest.js
                                  AgentCore Harness/Runtime pipeline (CloudWatch traces)
  gatewayAttacher.js gatewayDiscovery.js gatewayInterceptor.js gatewayManifest.js
  gatewayMessageBuilder.js gatewayNaming.js cfnResponse.js
                                  gateway discovery + interceptor attachment
  interceptor*.js                 the real-time interceptor (no AWS SDK)
  bedrockDelivery.js              finds (or, in create mode, enables) the account's Bedrock log bucket
  identityActor.js iamPermissions.js
                                  which agent / role a call belongs to
  aktoClient.js config.js         AKTO HTTP client, all settings and env vars
  scripts/stamp-version.js        writes VERSION into the zip at package time
  test/                           test suites (node test/run-all.js)

cloudformation/
  templates/client-aws-cf-template.yaml   THE template clients deploy
  templates/main-template.yaml            older discovery-only template (not used by the scripts)
  versions.json                           mirror of the published update channels
  parameters/                             parameter files for our own dev/prod stacks
  stackset/                               organization deployment: StackSet template,
                                          central markers bucket, its own versions.json
  scripts/deploy.sh                       deploy the client template to our own account
  scripts/release.sh                      publish a build / promote a channel (AKTO only)
  scripts/detach-interceptors.js          one-off: remove named interceptors from gateways

simple-deploy.sh, test-solution.sh        legacy non-CloudFormation install (pre-template)
```
