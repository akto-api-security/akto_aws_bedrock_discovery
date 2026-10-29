# Changelog

Published builds of the AKTO Bedrock integration, newest first. Builds live in
`s3://lambda-code-akto-<region>/`: `unified_bedrock/<version>/` from v4.4, and
`<version>/` at the bucket root before that.

**Template** marks releases that changed `client-aws-cf-template.yaml`. All other
releases are code-only. v3.x and v4.x were published in parallel during August
(v3.x: discovery only; v4.x: with gateway guardrails) and were merged in v4.4.

## v4.5 — 2026-09-10 · Template

- **Added:**
  - Self-updater Lambda that runs every 15 minutes. It reads
    `unified_bedrock/versions.json` (`stable`), runs `UpdateFunctionCode` on all three
    Lambdas, and records the build in the `akto:code-version` tag.
  - IAM permission analysis (`iamPermissions.js`): attached and inline policy documents,
    the trust policy and the permissions boundary, reduced to security tags.
  - Gateway security summary on harness messages: backends, authentication,
    interceptor, and the gateway role.
  - Token usage on AgentCore traces.
  - Session ID from caller-supplied `requestMetadata`.
- **Fixed:** the AgentCore user message now comes from the last real question, not
  from tool-result feedback or memory `<user_context>` injection.
- **Template:** updater role, function and schedule; `iam:GetRole`, `GetRolePolicy`,
  `ListRolePolicies`, `GetPolicy` and `GetPolicyVersion`.

## v4.4 — 2026-09-08

- **Merged** the v3.3–v3.6 discovery work into the gateway line, moving to
  `unified_bedrock/`.
- **Added:**
  - The build version is stamped into the zip (`VERSION`) and reported in the startup
    banner, the run summary and the manifest.
  - Quarantine of permanently rejected messages, recorded in the manifest.
  - Failed files are recorded and skipped.
  - Caller identity is sent as the ingest `ip`, so guardrail activity shows an Actor
    (`identityActor.js`).
- **Changed:**
  - Only the final exchange is emitted, and the trace is scoped to that exchange.
  - `MAX_TRACE_BYTES` is 64KB, with tool results truncated first.

## v4.3 — 2026-09-07

- **Fixed:** gateway naming is shared between the attacher and the interceptor
  (`gatewayNaming.js`), so discovery and live traffic agree on `bot-name`.

## v4.2 — 2026-09-03 · Template

- **Added:**
  - Gateway inventory announced to AKTO: targets, authorizer, role policies and tags,
    re-announced when the fingerprint changes (`gatewayManifest.js`).
  - A gateway name map is published to the interceptor, which uses it to tag live
    traffic.
- **Template:** attacher permissions for `GetGatewayTarget`, `ListTagsForResource`,
  `ListAttachedRolePolicies`, the markers bucket and
  `lambda:Get/UpdateFunctionConfiguration`.

## v3.7 — 2026-08-14

- **Added:** a 20KB per-message ceiling (`messageSizeCap.js`) and surrogate-safe
  truncation. Not carried into v4.4, which uses the 64KB trace cap.

## v3.6 — 2026-08-13

- **Added:** service agents. Direct model callers get a one-time discovery message and
  role/policy enrichment, and are tagged like agents.

## v3.4 — 2026-08-12

- **Added:** direct model traffic is ingested and attributed to the calling principal.
- **Fixed:** `GetAgent` throttling. The role and name now come from the manifest's role
  map instead of being fetched for every message.
- **Changed:** `SEND_BATCH_SIZE` is 1 and `MAX_TRACE_BYTES` is 64KB.

## v3.3 — 2026-08-11

- **Added:**
  - A run budget derived from the 10-minute schedule (80%), so runs never overlap.
  - An S3/AgentCore budget split with rollover.
  - Batches bounded by both count and bytes (5MB), with deadline-aware retries.
  - Identity resolved by execution role, with the session name as fallback; the role is
    persisted in the manifest.

## v4.1 — 2026-08-04 · Template

- **Added:**
  - AgentCore Gateway interception: the interceptor Lambda handles `tools/call`, fails
    open after 5s and strips credential headers.
  - The attacher Lambda, which runs as a custom resource and on a schedule. It
    auto-discovers gateways and never removes customer interceptors or modifies gateway
    roles.
  - An effective-configuration banner and a `RUN SUMMARY` line.
- **Template:** interceptor and attacher functions and roles;
  `EnableGatewayInterception` parameter.

## v3.2 — 2026-08-03

- **Added:**
  - AgentCore trace parsing for the Strands aggregate and generic `gen_ai.*` events.
  - Tool-call chain extraction.
  - `<thinking>` stripping.

## v3.1 — 2026-07-30 · Template

- **Added:** an AgentCore Harness/Runtime pipeline from CloudWatch traces, with its own
  manifest (`traceDiscovery.js`, `traceParser.js`, `logGroupReader.js`).
- **Changed:**
  - First-run lookback reduced from 7 days to 3.
  - Tool-call trace extraction on the S3 path, and in-progress `<thinking>` steps
    skipped.
- **Template:** `RuntimeLogGroupPrefix`; `logs:DescribeLogGroups` and
  `logs:FilterLogEvents`; `GetAgentRuntime`.

## v1.5 — 2026-07-29 · Template

- **Added:** standalone AgentCore Runtime discovery.
- **Fixed:** the role map is rebuilt from the manifest at startup, so previously
  discovered agents no longer resolve as unknown.
- **Template:** `bedrock-agentcore:ListAgentRuntimes`.

## v1.4 — 2026-07-28

- **Changed:** split into modules (`config`, `manifest`, `s3Logs`, `extractors`,
  `discovery`, `messageBuilder`, `aktoClient`).
- **Added:**
  - Incremental send-then-checkpoint flushing, time-boxed against the remaining Lambda
    time.
  - A per-request timeout and retry on AKTO ingestion.

## v1.2 — 2026-07-18 · Template

- **Added:**
  - An S3 manifest checkpoint (`akto/markers/bedrock-logs/manifest.json`).
  - `ListAgents` discovery messages.
- **Template:** schedule changed from 5 to 10 minutes; timeout from 300s to 900s;
  `bedrock:ListAgents` and `s3:GetObject` on markers; IAM role scope widened to `role/*`.
- **Known issue:** the checkpoint is written only at the end of a run. Fixed in v1.4.

## v1.1 — 2026-07-14

- Initial release: Bedrock Agent conversations are read from S3 model invocation logs,
  with agent, harness and IAM role metadata.
