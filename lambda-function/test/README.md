# Pipeline tests

No dev dependencies, no test framework, no build step. Every suite is a plain script
that stubs S3, the Bedrock/IAM APIs and `fetch`, then drives the real handler.

```bash
node test/run-all.js          # everything
node test/quarantine.test.js  # one suite
```

Exit code is non-zero if anything fails, so it drops into CI as-is.

## The suites

| Suite | What it protects |
|---|---|
| `checkpoint.test.js` | Progress is recorded even when nothing is sent; the watermark never moves backwards; one unreadable file can't stall the backlog. |
| `quarantine.test.js` | A message AKTO refuses permanently is set aside after retries instead of aborting the run — and the next run sends no duplicates. A *transient* failure still holds the checkpoint. |
| `sending.test.js` | One message per POST, bounded by bytes as well as count, deadline-aware; the 64KB trace cap truncates results before dropping steps. |
| `identity.test.js` | Role resolves the agent; the session name is the fallback for a shared role; unowned traffic becomes a named service agent; zero `GetAgent` calls when the manifest has the data. |
| `extraction.test.js` | Only the final exchange is emitted, never the replayed history; a tool result is not a user question; the trace is scoped to this turn. |
| `message-format.test.js` | `tag.source` and `tag['bot-name']` are always set — AKTO admits on those two, and a message missing either is stored and then invisible. |
| `pipeline.test.js` | The run budget keeps invocations from overlapping; S3 can't starve AgentCore; unused time is reclaimed rather than forfeited. |

## Writing another

`harness.js` does the setup. Mutate `state` between runs to drive a scenario:

```js
const { load, logEntry, mkFiles, quiet, invoke } = require('./harness');

const state = { manifest: null, files: mkFiles(5) };
state.entriesFor = (key) => [logEntry({ i: 0, answer: 'a reply long enough' })];
state.failPlan = (requestIds) => requestIds.includes('req-3') ? { status: 500, body: '…' } : null;

const restore = quiet();
const { handler } = load(state, { RUN_BUDGET_MS: '1500' });
const res = await invoke(handler);
restore();
```

Two things that will bite you:

- **`failPlan` receives requestIds, not a POST index.** A permanent failure must fail
  every attempt; keying on the POST number lets the retry succeed and the test lies.
- **`mkFiles()` is relative to `Date.now()`.** Don't regenerate it between runs in the
  same scenario — retry backoff burns real seconds, and a fresh list would legitimately
  look newer than the checkpoint you just wrote.

Some suites read `~/Downloads/11` (real client logs) when present and skip when not.
