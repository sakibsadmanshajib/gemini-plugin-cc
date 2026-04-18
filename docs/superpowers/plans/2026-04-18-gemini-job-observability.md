# Gemini Job Observability Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lightweight Gemini job observability so `/gemini:status` can report liveness, progress, diagnostics, and recommended actions for long-running background jobs.

**Architecture:** Add a small `job-observability.mjs` helper that owns bounded events, diagnostic classification, derived health fields, and safe updates to job files/index entries. Runtime modules emit events at natural boundaries, while status snapshot and rendering modules read derived fields directly instead of parsing logs. The implementation avoids a daemon/watchdog and limits process checks to status-time enrichment.

**Tech Stack:** Node.js ESM, `node:test`, filesystem-backed JSON state, Gemini ACP JSON-RPC over stdio or broker socket.

---

## File Structure

- Create `plugins/gemini/scripts/lib/job-observability.mjs`
  - Event retention, health field derivation, diagnostic classification, and safe job updates.
- Modify `plugins/gemini/scripts/lib/tracked-jobs.mjs`
  - Initialize observability fields and emit lifecycle/phase events.
- Modify `plugins/gemini/scripts/lib/gemini.mjs`
  - Accept a job observer/context and emit ACP/session/progress events.
- Modify `plugins/gemini/scripts/lib/acp-client.mjs`
  - Capture bounded direct stderr diagnostics, report transport/fallback diagnostics, and pass broker diagnostic notifications through.
- Modify `plugins/gemini/scripts/acp-broker.mjs`
  - Capture bounded broker child stderr diagnostics and forward safe diagnostics to the active client/job.
- Modify `plugins/gemini/scripts/gemini-companion.mjs`
  - Pass job observer/context from foreground/background commands into ACP calls.
- Modify `plugins/gemini/scripts/lib/job-control.mjs`
  - Enrich status snapshots with observability fields, recent events, runtime details, and status-time worker PID checks.
- Modify `plugins/gemini/scripts/lib/render.mjs`
  - Render active job health/last progress and detailed job observability sections.
- Modify `plugins/gemini/commands/status.md`
  - Preserve new health/progress columns and full detailed diagnostics.
- Modify `plugins/gemini/skills/gemini-cli-runtime/SKILL.md`
  - Explain status health labels and how agents should interpret them.
- Modify `plugins/gemini/skills/gemini-result-handling/SKILL.md`
  - Explain wait/cancel/retry guidance for incomplete or diagnostic-heavy jobs.
- Modify `README.md`
  - Document richer `/gemini:status` output and health labels.
- Add/modify tests:
  - `tests/job-observability.test.mjs`
  - `tests/job-control.test.mjs`
  - `tests/render.test.mjs`
  - `tests/commands.test.mjs`
  - `tests/acp-diagnostics.test.mjs` if ACP/broker diagnostic behavior needs separate focused coverage.

## Chunk 1: Observability Core

### Task 1: Add Failing Tests for Job Events and Diagnostics

**Files:**
- Create: `tests/job-observability.test.mjs`
- Create: `plugins/gemini/scripts/lib/job-observability.mjs`

- [ ] **Step 1: Write failing tests for event retention and derived fields**

Add tests shaped like:

```js
import test from "node:test";
import assert from "node:assert/strict";

import { initGitRepo, makeTempDir } from "./helpers.mjs";
import { createTrackedJob } from "../plugins/gemini/scripts/lib/tracked-jobs.mjs";
import { readJobFile } from "../plugins/gemini/scripts/lib/state.mjs";
import {
  classifyDiagnostic,
  recordJobEvent,
  MAX_JOB_EVENTS
} from "../plugins/gemini/scripts/lib/job-observability.mjs";

test("recordJobEvent retains bounded recent events and updates progress fields", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const job = createTrackedJob({ workspaceRoot: workspace, kind: "task", title: "observe" });

  for (let index = 0; index < MAX_JOB_EVENTS + 5; index++) {
    recordJobEvent(workspace, job.id, {
      type: "model_text_chunk",
      message: `chunk ${index}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    });
  }

  const stored = readJobFile(workspace, job.id);
  assert.equal(stored.events.length, MAX_JOB_EVENTS);
  assert.equal(stored.events[0].message, "chunk 5");
  assert.equal(stored.events.at(-1).message, `chunk ${MAX_JOB_EVENTS + 4}`);
  assert.equal(stored.healthStatus, "active");
  assert.equal(stored.lastProgressAt, stored.events.at(-1).timestamp);
  assert.equal(stored.lastModelOutputAt, stored.events.at(-1).timestamp);
});
```

- [ ] **Step 2: Write failing tests for diagnostic classification**

Add representative inputs for:

```js
test("classifyDiagnostic recognizes quota, auth, broker, model, and network messages", () => {
  assert.equal(classifyDiagnostic("quota exceeded, retrying later").kind, "rate_limit");
  assert.equal(classifyDiagnostic("401 auth expired; login required").kind, "auth");
  assert.equal(classifyDiagnostic("Broker is busy with another request.").kind, "broker");
  assert.equal(classifyDiagnostic("model is unavailable").kind, "model");
  assert.equal(classifyDiagnostic("ECONNRESET while calling API").kind, "network");
});
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `node --test tests/job-observability.test.mjs`

Expected: FAIL because `job-observability.mjs` and exported helpers do not exist yet.

### Task 2: Implement the Observability Helper

**Files:**
- Create: `plugins/gemini/scripts/lib/job-observability.mjs`
- Modify: `plugins/gemini/scripts/lib/state.mjs` only if a tiny helper is needed; prefer using existing read/write/upsert APIs.

- [ ] **Step 1: Add `job-observability.mjs` with constants and classifiers**

Implement:

```js
export const MAX_JOB_EVENTS = 50;
export const MAX_DIAGNOSTIC_LENGTH = 500;

export function classifyDiagnostic(text) {
  const value = String(text ?? "");
  const lower = value.toLowerCase();
  if (/(rate limit|quota|429|resource exhausted|retrying|backoff)/.test(lower)) return { kind: "rate_limit", healthStatus: "rate_limited" };
  if (/(auth|credential|login|unauthorized|401|permission denied)/.test(lower)) return { kind: "auth", healthStatus: "auth_required" };
  if (/(broker|socket|endpoint|busy|disconnected|not ready)/.test(lower)) return { kind: "broker", healthStatus: "broker_unhealthy" };
  if (/(model.*unavailable|unavailable.*model|not found.*model)/.test(lower)) return { kind: "model", healthStatus: "possibly_stalled" };
  if (/(econnreset|etimedout|network|dns|api error|connection)/.test(lower)) return { kind: "network", healthStatus: "possibly_stalled" };
  return { kind: "unknown", healthStatus: "quiet" };
}
```

Keep messages sanitized and length-bounded.

- [ ] **Step 2: Add `recordJobEvent(workspaceRoot, jobId, event)`**

Behavior:
- Read current job file.
- Normalize timestamp to `event.timestamp ?? nowIso()`.
- Append event and keep only `MAX_JOB_EVENTS`.
- Update derived fields:
  - all events update `lastHeartbeatAt`
  - progress events update `lastProgressAt`
  - `model_text_chunk` updates `lastModelOutputAt`
  - `tool_call` updates `lastToolCallAt`
  - diagnostic/error events update `lastDiagnosticAt`
  - diagnostics classify into `healthStatus`, `healthMessage`, and `recommendedAction`
- Write job file and upsert compact index fields.

- [ ] **Step 3: Run the focused tests**

Run: `node --test tests/job-observability.test.mjs`

Expected: PASS.

- [ ] **Step 4: Commit the core helper**

```bash
git add tests/job-observability.test.mjs plugins/gemini/scripts/lib/job-observability.mjs
git commit -m "feat: add job observability state helpers"
```

## Chunk 2: Lifecycle, Status Enrichment, and Rendering

### Task 3: Wire Lifecycle Events into Tracked Jobs

**Files:**
- Modify: `plugins/gemini/scripts/lib/tracked-jobs.mjs`
- Test: `tests/job-observability.test.mjs`

- [ ] **Step 1: Add failing tests for lifecycle events**

Cover:
- `createTrackedJob()` initializes `events: []` and `healthStatus: "queued"`.
- `runTrackedJob()` records `worker_started` and completion/failure events.
- `updateJobPhase()` records a `phase_changed` event.
- cancellation records a `worker_cancelled` or `cancelled` event, sets cancellation health, and recommends checking result/status or retrying when appropriate.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `node --test tests/job-observability.test.mjs`

Expected: FAIL because lifecycle functions do not emit events yet.

- [ ] **Step 3: Implement lifecycle event emission**

Use `recordJobEvent()` from `tracked-jobs.mjs`.

Do not let event write failures crash a job; status telemetry must be best-effort.

If needed, add a small exported helper such as `markTrackedJobCancelled(workspaceRoot, jobId, patch)` so `gemini-companion.mjs` cancellation can update the full job file and index consistently instead of only editing the state index.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/job-observability.test.mjs`

Expected: PASS.

### Task 4: Enrich Status Snapshots with Health and Worker Checks

**Files:**
- Create: `tests/job-control.test.mjs`
- Modify: `plugins/gemini/scripts/lib/job-control.mjs`

- [ ] **Step 1: Write failing tests for enriched status fields**

Create jobs with stored observability fields and assert `buildStatusSnapshot()` running entries include health fields, recent events, and runtime data.

- [ ] **Step 2: Write failing tests for `worker_missing`**

Inject a process checker:

```js
const snapshot = buildStatusSnapshot(workspace, {
  isProcessAlive: () => false
});
assert.equal(snapshot.running[0].healthStatus, "worker_missing");
assert.match(snapshot.running[0].recommendedAction, /cancel|result|retry/i);
```

Keep the production default as `process.kill(pid, 0)` guarded for platform errors.

- [ ] **Step 3: Write failing tests for quiet and possibly stalled thresholds**

Use injected time to avoid slow tests:

```js
const now = new Date("2026-01-01T00:30:00.000Z");

assert.equal(buildStatusSnapshot(workspace, {
  now,
  isProcessAlive: () => true
}).running[0].healthStatus, "possibly_stalled");
```

Cover at least:
- recent `lastProgressAt` remains `active`
- missing recent progress but recent heartbeat becomes `quiet`
- no recent heartbeat/progress beyond the threshold becomes `possibly_stalled`

The plan should introduce explicit constants, for example `QUIET_AFTER_MS` and `POSSIBLY_STALLED_AFTER_MS`, in `job-control.mjs` or `job-observability.mjs`.

- [ ] **Step 4: Run the focused test and confirm failure**

Run: `node --test tests/job-control.test.mjs`

Expected: FAIL because enrichment and injected liveness checks do not exist.

- [ ] **Step 5: Implement enrichment, quiet/stalled classification, and status-time PID checks**

Rules:
- Merge stored job-file observability fields into index jobs.
- Keep existing session filtering behavior.
- Only classify `worker_missing` for jobs marked `running` with a PID that is missing or not alive.
- Classify `active`, `quiet`, or `possibly_stalled` from `lastProgressAt` and `lastHeartbeatAt` when no stronger diagnostic health is present.
- Do not persist `worker_missing` unless existing update patterns make that safe; snapshot-level classification is enough.

- [ ] **Step 6: Run focused tests**

Run: `node --test tests/job-control.test.mjs`

Expected: PASS.

### Task 5: Render Active and Detailed Status Observability

**Files:**
- Modify: `tests/render.test.mjs`
- Modify: `plugins/gemini/scripts/lib/render.mjs`

- [ ] **Step 1: Write failing render tests**

Add tests asserting:
- Active jobs table includes `Health` and `Last Progress`.
- Detailed job status includes health, runtime, timestamps, recent events, diagnostics, and recommended action.

- [ ] **Step 2: Run render tests and confirm failure**

Run: `node --test tests/render.test.mjs`

Expected: FAIL because renderers still use old columns/sections.

- [ ] **Step 3: Implement rendering updates**

Keep active status compact. Prefer `-` for missing fields. Detailed status can include sections:
- `## Health`
- `## Runtime`
- `## Recent Events`

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/render.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit status lifecycle/render work**

```bash
git add tests/job-observability.test.mjs tests/job-control.test.mjs tests/render.test.mjs plugins/gemini/scripts/lib/tracked-jobs.mjs plugins/gemini/scripts/lib/job-control.mjs plugins/gemini/scripts/lib/render.mjs
git commit -m "feat: surface Gemini job health in status"
```

## Chunk 3: ACP Progress and Diagnostics

### Task 6: Map ACP Notifications to Job Events

**Files:**
- Modify: `plugins/gemini/scripts/lib/gemini.mjs`
- Test: `tests/job-observability.test.mjs` or `tests/acp-diagnostics.test.mjs`

- [ ] **Step 1: Write failing tests for notification mapping**

Export a small pure helper from `gemini.mjs`, for example `buildJobEventFromAcpNotification(notification)`, and test:
- `agent_message_chunk` becomes `model_text_chunk`
- `tool_call` becomes `tool_call`
- `file_change` becomes `file_change`
- unknown session updates become heartbeat-style `acp_notification`

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test tests/job-observability.test.mjs`

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement notification mapping and observer calls**

Add an optional `jobObserver` or `{ workspaceRoot, jobId }` option to `runAcpPrompt()`. In notification handling:
- keep existing `textChunks`, `toolCalls`, and `fileChanges` behavior unchanged
- record the mapped job event when a job context exists
- still call `options.onNotification(notification)`

Pass the option through `runAcpReview()` and `runAcpAdversarialReview()`.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/job-observability.test.mjs`

Expected: PASS.

### Task 7: Capture Direct and Broker ACP Diagnostics

**Files:**
- Create/modify: `tests/acp-diagnostics.test.mjs`
- Modify: `plugins/gemini/scripts/lib/acp-client.mjs`
- Modify: `plugins/gemini/scripts/acp-broker.mjs`
- Modify: `plugins/gemini/scripts/lib/gemini.mjs`

- [ ] **Step 1: Write failing tests for direct stderr diagnostics**

Use a fake `gemini` executable in a temp `PATH` that writes a representative warning to stderr and emits enough ACP JSON for initialize/session calls. Assert `onDiagnostic` or job observer receives a bounded diagnostic event.

- [ ] **Step 2: Write failing tests for broker diagnostic notification shape**

Keep this test focused. Either:
- exercise broker with a fake `gemini` child and socket client, or
- test an exported broker diagnostic formatter if full process wiring is too brittle.

Assert broker-managed child stderr is bounded and sent only as a diagnostic notification, not model output.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `node --test tests/acp-diagnostics.test.mjs`

Expected: FAIL because callbacks/notifications are not implemented.

- [ ] **Step 4: Implement direct stderr capture**

In `SpawnedAcpClient.initialize()`:
- replace `stderr.resume()` with bounded line/chunk handling
- call `options.onDiagnostic({ source: "direct-stderr", message })`
- keep draining stderr so back-pressure cannot block the child

- [ ] **Step 5: Implement broker stderr forwarding**

In `acp-broker.mjs`:
- read child stderr with bounded chunks/lines
- when `activeClient` exists, send a broker diagnostic notification such as:

```js
{
  jsonrpc: "2.0",
  method: "broker/diagnostic",
  params: { source: "broker-child-stderr", message }
}
```

- when no client is active, keep diagnostics in the broker log or an in-memory ring only
- forward ACP child exit as a diagnostic to the active client before rejecting pending requests when possible

- [ ] **Step 6: Handle diagnostics in client/Gemini runtime**

In `AcpClientBase.handleLine()`, route broker diagnostic notifications through `onDiagnostic` as well as existing notification handling where appropriate. In `runAcpPrompt()`, record diagnostic events for job context and classify them with `job-observability.mjs`.

- [ ] **Step 7: Run focused tests**

Run: `node --test tests/acp-diagnostics.test.mjs`

Expected: PASS.

### Task 8: Pass Job Context Through Companion Commands

**Files:**
- Modify: `plugins/gemini/scripts/gemini-companion.mjs`
- Test: `tests/job-observability.test.mjs` or `tests/acp-diagnostics.test.mjs`

- [ ] **Step 1: Add required failing tests for session/runtime observability**

Use pure helpers or mocked ACP calls so this does not require real Gemini:
- session creation records `acp_session_created`
- session loading records `acp_session_loaded`
- broker transport records `broker_connected`
- direct fallback records a bounded diagnostic/runtime field with the fallback reason
- command wiring passes `workspaceRoot` and `job.id` into task/review ACP calls

- [ ] **Step 2: Implement command wiring**

In foreground task and `task-worker`:
- pass `{ workspaceRoot, jobId }` or a constructed observer into ACP calls
- record `session_created` / `session_loaded` and runtime transport events from `runAcpPrompt()`

Do not change CLI flags or command output contracts except for richer status.

- [ ] **Step 3: Run relevant tests**

Run:

```bash
node --test tests/job-observability.test.mjs tests/acp-diagnostics.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Commit ACP integration**

```bash
git add tests/job-observability.test.mjs tests/acp-diagnostics.test.mjs plugins/gemini/scripts/lib/gemini.mjs plugins/gemini/scripts/lib/acp-client.mjs plugins/gemini/scripts/acp-broker.mjs plugins/gemini/scripts/gemini-companion.mjs
git commit -m "feat: record Gemini ACP progress diagnostics"
```

## Chunk 4: Documentation, Full Verification, and Review

### Task 9: Update README, Command Instructions, and Skills

**Files:**
- Modify: `README.md`
- Modify: `plugins/gemini/commands/status.md`
- Modify: `plugins/gemini/skills/gemini-cli-runtime/SKILL.md`
- Modify: `plugins/gemini/skills/gemini-result-handling/SKILL.md`
- Modify: `tests/commands.test.mjs`

- [ ] **Step 1: Write failing command/docs tests**

Update `tests/commands.test.mjs` to assert:
- `status.md` preserves health and last-progress fields
- README documents `/gemini:status <job-id>` health details
- runtime/result skills mention health labels or incomplete job guidance

- [ ] **Step 2: Run command docs tests and confirm failure**

Run: `node --test tests/commands.test.mjs`

Expected: FAIL because docs/skills are not updated.

- [ ] **Step 3: Update docs and skills**

README should briefly document:
- compact active table health fields
- detailed job status diagnostics
- health labels and recommended action examples

`status.md` should instruct Claude Code to preserve new columns.

`gemini-cli-runtime/SKILL.md` should tell agents how to interpret `active`, `quiet`, `possibly_stalled`, `rate_limited`, `auth_required`, `broker_unhealthy`, `worker_missing`, and `failed`.

`gemini-result-handling/SKILL.md` should say not to invent results for incomplete jobs and to preserve actionable diagnostics.

- [ ] **Step 4: Run command docs tests**

Run: `node --test tests/commands.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit docs and skills**

```bash
git add README.md plugins/gemini/commands/status.md plugins/gemini/skills/gemini-cli-runtime/SKILL.md plugins/gemini/skills/gemini-result-handling/SKILL.md tests/commands.test.mjs
git commit -m "docs: document Gemini job health status"
```

### Task 10: Full Test Run and Code Review

**Files:**
- All changed files.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: PASS.

- [ ] **Step 2: Inspect the diff manually**

Run:

```bash
git diff origin/main...HEAD
git status --short
```

Check for:
- no `.codex` or unrelated ignored files staged
- no unbounded stderr/output stored in job state
- no secrets/prompt contents persisted as diagnostics
- no daemon/watchdog behavior added
- status output remains compact for list view

- [ ] **Step 3: Use review skill before publishing**

Use `requesting-code-review` or an equivalent review pass. Fix any material findings with TDD and rerun `npm test`.

- [ ] **Step 4: Push branch and open PR**

Use the GitHub publishing workflow after tests and review pass:

```bash
git status --short
git push -u origin issue-14-job-observability
```

Open a draft PR targeting `main` with:
- summary of observability fields/events
- status rendering changes
- diagnostics capture notes
- docs/skill updates
- test command and result
- `Closes #14`
