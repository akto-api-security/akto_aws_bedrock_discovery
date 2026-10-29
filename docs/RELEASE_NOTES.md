# AKTO × AWS Bedrock Integration — Release Notes

> **Latest version: v4.5** (September 2026)
> Discovers AI agents running on AWS Bedrock, sends their conversations to AKTO for security analysis, and applies AKTO guardrails in real time to AgentCore Gateway traffic. Deployed with one CloudFormation template in your own AWS account.

**Latest template:** `https://lambda-code-akto-us-east-1.s3.us-east-1.amazonaws.com/unified_bedrock/v4.5/client-aws-cf-template.yaml`

---

## Release summary

| Version | Released | Highlights | Template update |
|---|---|---|---|
| **v4.5** | Sep 10, 2026 | Automatic updates, IAM permission analysis, session and token insights | Required |
| **v4.4** | Sep 8, 2026 | Unified build, versioned releases, message quarantine, cleaner conversations | — |
| **v4.3** | Sep 7, 2026 | Consistent gateway naming | — |
| **v4.2** | Sep 3, 2026 | AgentCore Gateway inventory in AKTO | Required |
| **v3.7** | Aug 14, 2026 | Message size ceiling | — |
| **v3.6** | Aug 13, 2026 | Service agents in inventory | — |
| **v3.4** | Aug 12, 2026 | Direct model traffic coverage, throttling fix | — |
| **v3.3** | Aug 11, 2026 | Run time budget, size-aware sending | — |
| **v4.1** | Aug 4, 2026 | AgentCore Gateway guardrails | Required |
| **v3.2** | Aug 3, 2026 | Multi-framework AgentCore trace parsing | — |
| **v3.1** | Jul 30, 2026 | AgentCore Harness/Runtime conversations | Required |
| **v1.5** | Jul 29, 2026 | AgentCore Runtime discovery | Required |
| **v1.4** | Jul 28, 2026 | Incremental checkpointing, resilient delivery | — |
| **v1.2** | Jul 18, 2026 | Checkpointing, automatic agent discovery | Required |
| **v1.1** | Jul 14, 2026 | Initial release | — |

*v3.x and v4.x shipped in parallel during August: v3.x carried discovery improvements, v4.x added Gateway Guardrails. v4.4 combines both lines.*

---

## v4.5 — September 10, 2026

**New**
- **Automatic updates:** The stack keeps itself on the latest AKTO release. It checks every 15 minutes and updates all AKTO Lambdas in place, with no redeploy needed.
- **IAM permission analysis:** Each agent's execution role is evaluated in full (attached and inline policies, trust policy, permissions boundary), so AKTO shows what an agent can actually access.
- **Gateway security context:** Harness conversations include the AgentCore Gateways they use, along with backend endpoints, authentication and interceptor status.
- **Token usage** is reported for AgentCore conversations.
- **Session tracking:** Conversation IDs supplied in Bedrock `requestMetadata` are picked up, to group related calls.

**Improved**
- AgentCore conversations now report the user's actual question. Tool results and AgentCore memory context are no longer mistaken for it.

**Template:** Adds the updater Lambda and its schedule, plus read-only IAM permissions for policy analysis.

---

## v4.4 — September 8, 2026

**New**
- **Unified build:** Combines Agent Discovery and Gateway Guardrails into a single release line.
- **Versioned releases:** Each build reports its version in Lambda logs and checkpoints.
- **Message quarantine:** A message AKTO permanently rejects is set aside after retries, so it can't block the rest of the data.
- **User attribution:** Guardrail activity shows the calling IAM user or role as the Actor.

**Improved**
- Each conversation reports only the latest exchange, not the full replayed history. This greatly reduces message size and duplicate content.
- Unreadable log files are recorded and skipped instead of stopping progress.
- Includes the v3.3–v3.6 improvements: run time budget, size-aware sending, service agents and throttling fixes.

---

## v4.3 — September 7, 2026

**Fixed**
- Gateway names are now identical in discovered inventory and in live traffic.

---

## v4.2 — September 3, 2026

**New**
- **Gateway inventory:** Protected AgentCore Gateways appear in AKTO with their targets, authentication, execution-role policies and tags.
- Live gateway traffic is tagged with the gateway name.
- Inventory refreshes automatically when a gateway changes (a new target, authorizer or interception point).

**Template:** Adds read-only permissions for gateway targets, tags and role policies.

---

## v3.7 — August 14, 2026

**Improved**
- A hard per-message size ceiling, with Unicode-safe truncation of long content.

---

## v3.6 — August 13, 2026

**New**
- **Service agents:** Applications or users that call Bedrock models directly appear in AKTO as discovered agents, enriched with their IAM role and policies.

---

## v3.4 — August 12, 2026

**New**
- **Direct model traffic:** Bedrock model calls made without an agent (from applications or users) are now captured and attributed to the caller.

**Improved**
- Far fewer Bedrock API calls per run, which resolves `TooManyRequests` throttling on busy accounts.
- Large tool outputs are trimmed so a single long conversation can't exceed ingestion limits.

---

## v3.3 — August 11, 2026

**Improved**
- **Run time budget:** Each run finishes before the next one is scheduled, preventing overlapping runs and duplicate data.
- Bedrock Agent and AgentCore processing share each run fairly, so a large backlog in one never starves the other.
- Message batches are limited by size as well as count, and retries respect the remaining run time.
- Agent identity is resolved from the caller's IAM role, with the session name used when several agents share a role.

---

## v4.1 — August 4, 2026

**New**
- **AgentCore Gateway Guardrails (optional):** AKTO guardrails are applied in real time to MCP `tools/call` traffic, which can be blocked, redacted or monitored.
- Gateways are detected automatically, so no gateway IDs need to be supplied. New gateways are protected as they are created.
- **Fail-open by design:** Traffic is never blocked because AKTO is slow or unreachable (5-second timeout).
- Existing customer interceptors and gateway IAM roles are never modified. Credential headers are removed before anything is sent to AKTO.

**Improved**
- Each run logs its effective configuration and a summary, making troubleshooting faster.

**Template:** Adds the interceptor and gateway attacher Lambdas and the `EnableGatewayInterception` parameter.

---

## v3.2 — August 3, 2026

**Improved**
- AgentCore traces are parsed across agent frameworks (Strands and generic OpenTelemetry GenAI events).
- Tool-call chains are captured for AgentCore conversations.
- Model reasoning (`<thinking>`) is removed so only the final answer is shown.

---

## v3.1 — July 30, 2026

**New**
- **AgentCore Harness and Runtime conversations** are captured from CloudWatch observability traces. This pipeline runs independently of Bedrock Agent log processing.

**Improved**
- The first-run lookback is reduced from 7 days to 3, so the initial sync is faster.
- Tool calls and their results are captured for Bedrock Agent conversations.

**Template:** Adds the optional `RuntimeLogGroupPrefix` parameter and read-only CloudWatch Logs permissions. Requires CloudWatch Transaction Search to be enabled for AgentCore data.

---

## v1.5 — July 29, 2026

**New**
- Standalone AgentCore Runtimes are discovered.

**Fixed**
- Agents discovered in an earlier run are now correctly matched to later traffic.

---

## v1.4 — July 28, 2026

**Improved**
- **Incremental checkpointing:** Progress is saved continuously, so an interrupted run resumes where it stopped instead of starting over.
- Delivery to AKTO has a request timeout and automatic retries.

---

## v1.2 — July 18, 2026

**New**
- **Checkpointing:** Only new logs are processed on each run.
- **Automatic discovery** of every Bedrock Agent in the account.

**Template:** Schedule changes to every 10 minutes and the Lambda timeout to 15 minutes. Adds permissions for agent listing and checkpoint reads.

---

## v1.1 — July 14, 2026

- Initial release. Bedrock Agent conversations are read from model invocation logs in S3, with agent, harness and IAM role metadata.

---

## Upgrading

- **On v4.5 or later:** Nothing to do. Updates install automatically.
- **On an earlier version:** Update your CloudFormation stack once with the latest template URL above (*CloudFormation → Stack → Update → Replace current template*). Set **LambdaCodeVersion** to `v4.5` and keep your other parameter values. All later releases then install automatically.

**Check your version:** Look at the `akto:code-version` tag on the AKTO Lambda function, or the build version on the first line of each run in its CloudWatch logs.
