# Developer Guide

This guide is for AKTO engineers changing this project. Read [README.md](README.md)
first for how the pieces fit together.

## Golden rules

1. **Clients pick up code automatically.** Each client stack has an updater that installs
   whatever `unified_bedrock/versions.json` → `stable` names, within 15 minutes. Moving
   `stable` is effectively a deploy to every client. Always go through `canary` first.
2. **A published version folder is never overwritten.** `unified_bedrock/v4.5/` is
   referenced by clients' stacks (`LambdaCodeVersion`) and by the updater. A fix is a new
   version.
3. **Code changes don't need a template change.** The updater swaps code only. Ship a new
   template only when resources, permissions, parameters or env vars change, and remember
   that existing clients must then run a stack update themselves.
4. **One zip, three handlers.** `index.handler`, `gatewayAttacher.handler` and
   `interceptor.handler` share modules. The interceptor must stay AWS-SDK-free and import
   only `interceptorConfig.js`, not `config.js`.
5. **The interceptor must fail open.** Any error path in it must return the traffic
   unchanged.

## Local setup

```bash
cd lambda-function
npm ci
node test/run-all.js     # all suites; non-zero exit on any failure
node test/quarantine.test.js   # a single suite
```

The tests need no framework and no AWS credentials. They stub S3, the Bedrock and IAM
APIs and `fetch`, then drive the real handlers.

| Suite | Protects |
|---|---|
| `checkpoint.test.js` | Progress is recorded even when nothing is sent; the watermark never moves back; one bad file can't stall the backlog |
| `quarantine.test.js` | A permanently refused message is set aside after retries without duplicates; a transient failure still holds the checkpoint |
| `sending.test.js` | One message per POST, bounded by bytes and count, deadline-aware; the 64KB trace cap truncates before dropping steps |
| `identity.test.js`, `identityActor.test.js` | The role or session resolves the agent; unowned traffic becomes a named service agent; no `GetAgent` when the manifest already knows |
| `extraction.test.js` | Only the final exchange is emitted; a tool result is not a user question |
| `message-format.test.js` | `tag.source` and `tag['bot-name']` are always set (AKTO drops messages without them) |
| `pipeline.test.js` | The run budget prevents overlapping invocations; S3 can't starve AgentCore |
| `stackset.test.js` | Single mode is unchanged; stackset checkpoints sit under `<account>/<region>/`; the logs bucket is discovered; a CloudWatch-only account is never modified; `create` mode provisions only when nothing exists |

Sample payloads live in `test/payloads/`. To write a new scenario, use `test/harness.js`:

```js
const { load, logEntry, mkFiles, quiet, invoke } = require('./harness');
const state = { manifest: null, files: mkFiles(5) };
state.entriesFor = () => [logEntry({ i: 0, answer: 'a reply long enough' })];
state.failPlan = (requestIds) => requestIds.includes('req-3') ? { status: 500, body: '…' } : null;
const restore = quiet();
const { handler } = load(state, { RUN_BUDGET_MS: '1500' });
const res = await invoke(handler);
restore();
```

Two gotchas: `failPlan` is keyed by requestId, not POST index (otherwise a retry
succeeds and the test lies), and `mkFiles()` is relative to `Date.now()`, so don't
regenerate it between runs of one scenario.

## Single account vs StackSet

One codebase, two templates, two release lines. `DEPLOYMENT_MODE=stackset` (set only by
the StackSet template) is the only switch in the code:
- it changes `MARKERS_PREFIX` in `config.js` to `<account>/<region>/`, which moves all
  three manifests (S3, traces, gateways)
- it makes `LOGS_BUCKET_NAME` optional; `bedrockDelivery.js` then resolves the bucket
  from `GetModelInvocationLoggingConfiguration`

Unset, everything behaves exactly as in the single-account build. A change to shared
code therefore ships on both lines, and must pass `stackset.test.js` as well.

The StackSet template is the single-account template plus StackSet-specific changes:
resource names, permissions scoped by account prefix and log key, discovery and create
parameters, and the `unified_bedrock_stackset/` code folder. When you change
`client-aws-cf-template.yaml` (a permission, a resource, the updater), make the same
change in `cloudformation/stackset/client-aws-cf-stackset-template.yaml`.

## Making a change

1. Branch from the latest feature branch (currently `feature/bedrock_unified_latest`).
2. Change the code, adding new settings and env vars to `config.js` (or
   `interceptorConfig.js` for the interceptor).
3. Add or extend a test that fails without your change. Run `node test/run-all.js`.
4. If you changed the template:
   - also update the IAM policy for any new AWS call. A missing permission only shows up
     at runtime, as `AccessDenied` in the Lambda logs.
   - `aws cloudformation validate-template --template-body file://cloudformation/templates/client-aws-cf-template.yaml`
   - keep `CLIENT_DEPLOYMENT.md` (parameters, permissions) in step.
5. Test on our own account (next section) before releasing.

## Testing in our own AWS account

**Code only.** Build a test zip and push it straight to our dev Lambda. This bypasses
S3 and the updater:

```bash
cd lambda-function
VERSION=v4.6-dev npm run deploy    # packages, then update-function-code on akto-bedrock-log-processor-unified-<acct>
aws lambda invoke --function-name akto-bedrock-log-processor-unified-<acct> out.json && cat out.json
aws logs tail /aws/lambda/akto-bedrock-log-processor-unified-<acct> --follow
```

`npm run deploy` updates only the discovery Lambda. For attacher or interceptor changes,
run `aws lambda update-function-code --zip-file fileb://../akto-bedrock-processor.zip` on
those functions too.

Our dev stack's updater will put the channel build back within 15 minutes. For a longer
test, disable `akto-bedrock-updater-schedule-<acct>-<region>` and re-enable it afterwards.

**StackSet changes.** Run `DEPLOYMENT_MODE=stackset` locally through
`test/stackset.test.js` first. Then publish to the StackSet line, promote `canary`, and
deploy the StackSet to a test OU with one or two member accounts. Check
`s3://<markers-bucket>/<account>/<region>/` fills for each account, and that an account
with CloudWatch-only logging is reported as skipped.

**Template changes.** Deploy the template to our own account:

```bash
cd cloudformation
# edit parameters/dev-parameters.json (real bucket, endpoint, key, a published LambdaCodeVersion)
./scripts/deploy.sh dev
```

What to check:
- the discovery run completes without errors
- the manifests under `akto/markers/` advance
- traffic appears in AKTO
- for gateway changes: the attacher logs and a real `tools/call` that is allowed and one
  that is blocked (start with `INTERCEPTOR_DRY_RUN=true` on the attacher to see decisions
  without touching gateways)

## Releasing

Everything is in `cloudformation/scripts/release.sh`. It needs AWS credentials for the
account that owns `lambda-code-akto-<region>`.

```bash
cd cloudformation/scripts

# 1. Publish: runs the tests, builds with VERSION stamped, uploads the zip + client
#    template to unified_bedrock/v4.6/. Refuses if v4.6 already exists. Affects nobody.
./release.sh publish v4.6

# 2. Canary: our own test account runs UPDATE_CHANNEL=canary and picks it up within 15 min.
./release.sh promote canary v4.6
#    Check its updater log ("... -> v4.6"), the akto:code-version tag, and a clean run.

# 3. Stable: every client moves to v4.6 within 15 minutes.
./release.sh promote stable v4.6

# 4. Commit cloudformation/versions.json so the repo matches S3.
```

Regions default to `us-east-1`. For more regions, run
`REGIONS="us-east-1 eu-west-1" ./release.sh ...`. Every region where a client runs needs
the zip **and** `versions.json`.

**StackSet line:** the same commands with `--stackset`, for example
`./release.sh --stackset publish v1.1`. They publish to `unified_bedrock_stackset/` with
`cloudformation/stackset/versions.json`. Publish to **every region the StackSet targets**,
because each stack instance pulls its code from its own region's bucket.

**Rollback:** `./release.sh promote stable v4.5`. The updater moves everyone back on its
next check, so no client action is needed.

**If the template changed:** publish uploads it alongside the zip. Share the new
template URL with clients that need the new resources. Existing stacks keep running the
old template with new code, so new code must not depend on a new env var or permission
without a safe fallback.

## Useful tools

- `cloudformation/scripts/detach-interceptors.js` removes named interceptor ARNs from
  gateways. It is a dry run unless `--apply` is passed, and backs up each gateway's
  config to `./gateway-backups/` (git-ignored) first.
- `lambda-function/VERSION` is written by `scripts/stamp-version.js` at package time and
  is git-ignored. It is the version each message reports to AKTO.
