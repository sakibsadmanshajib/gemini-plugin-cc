# Gemini Job Observability Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every Critical and Important finding from the consolidated PR #16 review (6 Critical + 12 Important) without introducing cross-process locks or watchdogs.

**Architecture:** In-process per-jobId / per-workspace promise-chain mutex + atomic-rename JSON writes. Transport-gated broker/diagnostic with single-dispatch. One-cycle lifecycle persistence helper. Sticky diagnostic classification. Event hygiene (no model text, sanitized source, typed prefix matching, numeric passthrough).

**Tech Stack:** Node.js ESM, `node:test`, `fs`/`node:fs`, filesystem-backed JSON state, JSON-RPC over stdio/unix socket.

---

## File Structure

### New
- `plugins/gemini/scripts/lib/atomic-state.mjs` — promise-chain mutexes + atomic rename helper.
- `tests/atomic-state.test.mjs` — unit tests for the mutex/rename helpers.

### Modified
- `plugins/gemini/scripts/lib/state.mjs` — `writeJobFile`, `saveState` use atomic rename + workspace mutex.
- `plugins/gemini/scripts/lib/job-observability.mjs` — `recordJobEvent` serializes per job; `sanitizeEvent` passes numerics; `isDiagnosticEvent` exact/prefix; `compactJobIndexEntry` includes `errorMessage` and `summary`; import `MAX_DIAGNOSTIC_LENGTH` from `acp-diagnostics.mjs`.
- `plugins/gemini/scripts/lib/acp-client.mjs` — transport-gated `broker/diagnostic` with single-dispatch; overflow emits synthetic `acp-transport` diagnostic.
- `plugins/gemini/scripts/acp-broker.mjs` — `handleClientConnection` line-buffer cap; ring stores sanitized prebuilt notifications.
- `plugins/gemini/scripts/lib/acp-diagnostics.mjs` — `buildBrokerDiagnosticNotification` sanitizes `source`; `createStderrDiagnosticCollector` overflow emits `[truncated diagnostic]`.
- `plugins/gemini/scripts/lib/gemini.mjs` — `buildJobEventFromAcpNotification` for `agent_message_chunk` records `{ type, chars }`; remove `BROKER_DIAGNOSTIC_METHOD` guard in `notificationHandler`.
- `plugins/gemini/scripts/lib/job-control.mjs` — `classifyRuntimeHealth` preserves `DIAGNOSTIC_HEALTH_STATUSES`.
- `plugins/gemini/scripts/lib/render.mjs` — `renderSingleJobStatus` includes `runtime.transport`.
- `plugins/gemini/scripts/lib/tracked-jobs.mjs` — new `persistJobStateAndEvent`; `markTrackedJobCancelled` returns `{ job, eventRecorded }`.
- `README.md`, `plugins/gemini/skills/gemini-cli-runtime/SKILL.md` — add `completed` and `cancelled` health labels.
- `tests/job-observability.test.mjs`, `tests/state.test.mjs`, `tests/acp-diagnostics.test.mjs`, `tests/job-control.test.mjs`, `tests/render.test.mjs`, `tests/commands.test.mjs` — expanded coverage.
- `tests/acp-client.test.mjs` (new) — transport gating + single-dispatch + overflow diagnostic.

---

## Chunk 1: Atomic State Helpers (fixes C5, C6)

### Task 1.1: Atomic helpers + mutex

**Files:**
- Create: `plugins/gemini/scripts/lib/atomic-state.mjs`
- Create: `tests/atomic-state.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
// tests/atomic-state.test.mjs
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  withJobMutex,
  withWorkspaceMutex,
  writeJsonAtomic
} from "../plugins/gemini/scripts/lib/atomic-state.mjs";

test("withJobMutex serializes same-jobId writers and parallelises different jobs", async () => {
  const ws = makeTempDir();
  const order = [];
  const slowA = withJobMutex(ws, "job-1", async () => {
    await new Promise((r) => setTimeout(r, 20));
    order.push("A");
  });
  const slowB = withJobMutex(ws, "job-1", async () => {
    order.push("B");
  });
  const parallel = withJobMutex(ws, "job-2", async () => {
    order.push("P");
  });
  await Promise.all([slowA, slowB, parallel]);
  assert.equal(order[order.length - 2], "A", "A must complete before B on the same jobId");
  assert.equal(order.indexOf("B") > order.indexOf("A"), true);
  assert.ok(order.includes("P"));
});

test("writeJsonAtomic writes a complete file atomically", () => {
  const ws = makeTempDir();
  const target = path.join(ws, "state.json");
  writeJsonAtomic(target, { jobs: [{ id: "a" }] });
  const read = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(read.jobs, [{ id: "a" }]);
  const siblings = fs.readdirSync(ws).filter((f) => f.startsWith("state.json."));
  assert.equal(siblings.length, 0, "no tmp files should remain");
});

test("writeJsonAtomic does not leave a partial file on write failure", () => {
  const ws = makeTempDir();
  const target = path.join(ws, "state.json");
  fs.writeFileSync(target, JSON.stringify({ jobs: [{ id: "prev" }] }));
  // Force failure: pass a value containing a BigInt (JSON.stringify throws TypeError).
  assert.throws(() => writeJsonAtomic(target, { bad: 1n }));
  const read = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(read.jobs, [{ id: "prev" }], "target file must be unchanged on failure");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/atomic-state.test.mjs`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helper**

```js
// plugins/gemini/scripts/lib/atomic-state.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const jobMutexes = new Map();
const workspaceMutexes = new Map();

function acquire(map, key) {
  const prev = map.get(key) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  map.set(
    key,
    prev.then(() => next)
  );
  return { prev, release };
}

async function runWithMutex(map, key, fn) {
  const { prev, release } = acquire(map, key);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    // Drop the entry if no one else is waiting.
    if (map.get(key) === prev) {
      map.delete(key);
    }
  }
}

export function withJobMutex(workspaceRoot, jobId, fn) {
  return runWithMutex(jobMutexes, `${workspaceRoot}::${jobId}`, fn);
}

export function withWorkspaceMutex(workspaceRoot, fn) {
  return runWithMutex(workspaceMutexes, `${workspaceRoot}`, fn);
}

export function writeJsonAtomic(targetPath, value) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(dir, `${base}.tmp.${crypto.randomBytes(6).toString("hex")}`);
  const body = JSON.stringify(value, null, 2);
  fs.writeFileSync(tmp, body);
  try {
    fs.renameSync(tmp, targetPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `node --test tests/atomic-state.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit after Task 1.3 (deferred to end of chunk).**

### Task 1.2: Integrate into `state.mjs`

**Files:**
- Modify: `plugins/gemini/scripts/lib/state.mjs`
- Modify: `tests/state.test.mjs`

- [ ] **Step 1: Add a failing test for concurrent `saveState` pruning safety**

```js
// tests/state.test.mjs — new test
import { initGitRepo } from "./helpers.mjs";
import { createTrackedJob } from "../plugins/gemini/scripts/lib/tracked-jobs.mjs";
import { loadState, saveState } from "../plugins/gemini/scripts/lib/state.mjs";

test("concurrent saveState writers do not unlink each other's job artifacts", async () => {
  const ws = makeTempDir();
  initGitRepo(ws);
  const jobA = createTrackedJob({ workspaceRoot: ws, kind: "task", title: "a" });
  const jobB = createTrackedJob({ workspaceRoot: ws, kind: "task", title: "b" });

  const stateA = loadState(ws);
  const stateB = loadState(ws);
  stateA.jobs = stateA.jobs.filter((j) => j.id === jobA.id);
  stateB.jobs = stateB.jobs.filter((j) => j.id === jobB.id);
  await Promise.all([
    Promise.resolve().then(() => saveState(ws, stateA)),
    Promise.resolve().then(() => saveState(ws, stateB))
  ]);

  const after = loadState(ws);
  const ids = new Set(after.jobs.map((j) => j.id));
  assert.ok(ids.has(jobA.id) || ids.has(jobB.id));
  // Either job's files must still be on disk (not both unlinked).
  const aFile = path.join(ws, ".gemini-plugin-cc", "jobs", `${jobA.id}.json`);
  const bFile = path.join(ws, ".gemini-plugin-cc", "jobs", `${jobB.id}.json`);
  assert.ok(fs.existsSync(aFile) || fs.existsSync(bFile));
});
```

- [ ] **Step 2: Run failing test**

Run: `node --test tests/state.test.mjs`
Expected: FAIL — race unlinks both files.

- [ ] **Step 3: Wire mutex + atomic writes into `state.mjs`**

In `writeJobFile`:
```js
import { withJobMutex, writeJsonAtomic } from "./atomic-state.mjs";

export function writeJobFile(workspaceRoot, jobId, value) {
  const file = resolveJobFile(workspaceRoot, jobId);
  return withJobMutex(workspaceRoot, jobId, async () => {
    writeJsonAtomic(file, value);
  });
}
```

In `saveState`:
```js
import { withWorkspaceMutex, writeJsonAtomic } from "./atomic-state.mjs";

export function saveState(workspaceRoot, state) {
  const file = resolveStateFile(workspaceRoot);
  return withWorkspaceMutex(workspaceRoot, async () => {
    // Re-load the current on-disk state inside the mutex so the caller's
    // stale snapshot cannot delete another writer's in-flight job artifacts.
    const current = loadState(workspaceRoot);
    const merged = reconcileState(current, state);
    writeJsonAtomic(file, merged);
    // Existing prune logic (whatever the file currently does to remove
    // dropped job artifacts) now operates on the reconciled state. If it
    // was inline in saveState, extract it into a small helper and call
    // it with (workspaceRoot, current, merged) — never with the caller's
    // stale snapshot.
  });
}

function reconcileState(current, incoming) {
  // Union the jobs array by id, preferring incoming updates for known ids.
  const byId = new Map(current.jobs.map((j) => [j.id, j]));
  for (const job of incoming.jobs ?? []) {
    byId.set(job.id, { ...byId.get(job.id), ...job });
  }
  return { ...current, ...incoming, jobs: Array.from(byId.values()) };
}
```

Keep any existing indexed-job cap behaviour that the file had before; apply it inside `reconcileState` if needed.

Note: any existing `saveState` sync callers must handle the returned promise. Search-and-update.

- [ ] **Step 4: Run full suite**

Run: `npm test`
Expected: PASS (76 + new test).

### Task 1.3: Wire mutex into `recordJobEvent`

**Files:**
- Modify: `plugins/gemini/scripts/lib/job-observability.mjs`
- Modify: `tests/job-observability.test.mjs`

- [ ] **Step 1: Add a failing test for concurrent `recordJobEvent` preserving all events**

```js
test("concurrent recordJobEvent calls on the same job retain all events", async () => {
  const ws = makeTempDir();
  initGitRepo(ws);
  const job = createTrackedJob({ workspaceRoot: ws, kind: "task", title: "race" });

  const N = 20;
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      recordJobEvent(ws, job.id, { type: "model_text_chunk", message: `chunk-${i}` })
    )
  );

  const stored = readJobFile(ws, job.id);
  const observed = new Set(stored.events.map((e) => e.message));
  for (let i = 0; i < N; i++) assert.ok(observed.has(`chunk-${i}`), `event chunk-${i} missing`);
});
```

- [ ] **Step 2: Run and verify RED**

Run: `node --test tests/job-observability.test.mjs`
Expected: FAIL — events lost under race.

- [ ] **Step 3: Wrap `recordJobEvent` read-modify-write in `withJobMutex`**

```js
import { withJobMutex } from "./atomic-state.mjs";

export function recordJobEvent(workspaceRoot, jobId, event) {
  return withJobMutex(workspaceRoot, jobId, async () => {
    const existing = readJobFile(workspaceRoot, jobId);
    if (!existing) return null;
    // ... existing normalization + patch logic unchanged ...
    const nextJob = { ...existing, ...patch };
    writeJobFile(workspaceRoot, jobId, nextJob);
    upsertCompactJobIndexEntry(workspaceRoot, nextJob);
    return nextJob;
  });
}
```

Update every caller to `await recordJobEvent(...)` or to ignore the returned promise. Adjust `safeRecordJobEvent` to await internally.

- [ ] **Step 4: Run focused and full suites**

Run: `node --test tests/job-observability.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 5: Commit chunk 1**

```bash
git add plugins/gemini/scripts/lib/atomic-state.mjs plugins/gemini/scripts/lib/state.mjs plugins/gemini/scripts/lib/job-observability.mjs tests/atomic-state.test.mjs tests/state.test.mjs tests/job-observability.test.mjs
git commit -m "feat: atomic job state writes with per-job mutex"
```

---

## Chunk 2: Broker Diagnostic Trust Boundary (fixes C2, C3)

### Task 2.1: Failing tests for forgery + single-dispatch

**Files:**
- Create: `tests/acp-client.test.mjs`

- [ ] **Step 1: Write failing tests**

```js
// tests/acp-client.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

class FakeClient {
  constructor(transport) {
    this.transport = transport;
    this.notifications = [];
    this.diagnostics = [];
    this.onNotification = (n) => this.notifications.push(n);
    this.onDiagnostic = (d) => this.diagnostics.push(d);
  }
}

// Import AcpClientBase prototype helper so we can exercise handleLine without spawning.
import { __testing } from "../plugins/gemini/scripts/lib/acp-client.mjs";

test("direct-mode ignores stdout-forged broker/diagnostic as trusted", () => {
  const client = Object.assign(new FakeClient("direct"), { pending: new Map(), nextId: 1, lineBuffer: "" });
  __testing.handleLineOn(client, JSON.stringify({
    jsonrpc: "2.0",
    method: "broker/diagnostic",
    params: { source: "broker", message: "fake rate limit" }
  }));
  assert.equal(client.diagnostics.length, 0, "direct-mode must not route forged broker/diagnostic");
  assert.equal(client.notifications.length, 1, "direct-mode treats it as a plain notification");
});

test("broker-mode single-dispatches broker/diagnostic to onDiagnostic only", () => {
  const client = Object.assign(new FakeClient("broker"), { pending: new Map(), nextId: 1, lineBuffer: "" });
  __testing.handleLineOn(client, JSON.stringify({
    jsonrpc: "2.0",
    method: "broker/diagnostic",
    params: { source: "broker-child-stderr", message: "quota" }
  }));
  assert.equal(client.diagnostics.length, 1);
  assert.equal(client.notifications.length, 0, "broker-mode must not double-dispatch");
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/acp-client.test.mjs`
Expected: FAIL — `__testing` export missing; double-dispatch still happens.

### Task 2.2: Transport gate + single-dispatch + kill gemini.mjs guard

- [ ] **Step 1: Modify `AcpClientBase.handleLine`**

```js
// Notification branch in handleLine:
if (message.method === BROKER_DIAGNOSTIC_METHOD) {
  if (this.transport === "broker") {
    if (this.onDiagnostic) {
      try {
        this.onDiagnostic({
          source: message.params?.source ?? "broker",
          message: message.params?.message ?? ""
        });
      } catch { /* best-effort */ }
    }
    return; // single-dispatch: do NOT also call onNotification
  }
  // Direct mode: treat as a regular notification; fall through.
}

if (message.method && this.onNotification) {
  this.onNotification(message);
}
```

- [ ] **Step 2: Export `__testing` helper**

```js
export const __testing = {
  handleLineOn(client, line) {
    return AcpClientBase.prototype.handleLine.call(client, line);
  }
};
```

- [ ] **Step 3: Remove the `BROKER_DIAGNOSTIC_METHOD` guard in `gemini.mjs`**

Delete the early-return branch in `notificationHandler` inside `runAcpPrompt`:

```diff
-    if (notification?.method === BROKER_DIAGNOSTIC_METHOD) { ... return; }
```

The diagnostic path is now driven exclusively by `onDiagnostic` (which still records via `recordObserverEvent(observer, formatBrokerDiagnostic(payload))`). Remove the `BROKER_DIAGNOSTIC_METHOD` import if unused.

- [ ] **Step 4: Run tests**

Run: `node --test tests/acp-client.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 5: Commit chunk 2**

```bash
git add plugins/gemini/scripts/lib/acp-client.mjs plugins/gemini/scripts/lib/gemini.mjs tests/acp-client.test.mjs
git commit -m "fix: gate broker diagnostics by transport and single-dispatch"
```

---

## Chunk 3: Single-Cycle Lifecycle Persistence (fixes C4, I7, I12)

### Task 3.1: Failing tests for summary + errorMessage preservation + return shape

**Files:**
- Modify: `tests/tracked-jobs.test.mjs` (create if missing) or extend `tests/job-observability.test.mjs`.

- [ ] **Step 1: Write failing tests**

```js
test("runTrackedJob completion preserves summary on the compact index", async () => {
  const ws = makeTempDir();
  initGitRepo(ws);
  const job = createTrackedJob({ workspaceRoot: ws, kind: "task", title: "t" });
  await runTrackedJob(job, async () => ({ exitStatus: 0, summary: "Done.", threadId: "th", turnId: 1 }));
  const idx = loadState(ws).jobs.find((j) => j.id === job.id);
  assert.equal(idx.summary, "Done.");
});

test("runTrackedJob failure path keeps errorMessage on the compact index", async () => {
  const ws = makeTempDir();
  initGitRepo(ws);
  const job = createTrackedJob({ workspaceRoot: ws, kind: "task", title: "t" });
  await runTrackedJob(job, async () => { throw new Error("Boom"); }).catch(() => {});
  const idx = loadState(ws).jobs.find((j) => j.id === job.id);
  assert.match(idx.errorMessage ?? "", /Boom/);
});

test("markTrackedJobCancelled returns { job, eventRecorded }", () => {
  const ws = makeTempDir();
  initGitRepo(ws);
  const job = createTrackedJob({ workspaceRoot: ws, kind: "task", title: "t" });
  const result = markTrackedJobCancelled(ws, job.id, { reason: "user" });
  assert.equal(typeof result, "object");
  assert.equal(result.eventRecorded, true);
  assert.equal(result.job.healthStatus, "cancelled");
});
```

- [ ] **Step 2: Verify RED**

Run: `node --test tests/tracked-jobs.test.mjs` (or whichever file holds these) — expect failures.

### Task 3.2: Implement `persistJobStateAndEvent` helper

- [ ] **Step 1: Add helper to `tracked-jobs.mjs`**

```js
import { withJobMutex } from "./atomic-state.mjs";
import { readJobFile, writeJobFile } from "./state.mjs";
import { normalizeAndAppendEvent, upsertCompactJobIndexEntry } from "./job-observability.mjs";

export async function persistJobStateAndEvent(workspaceRoot, jobId, patch, event) {
  return withJobMutex(workspaceRoot, jobId, async () => {
    const existing = readJobFile(workspaceRoot, jobId) ?? { id: jobId };
    const merged = { ...existing, ...patch };
    if (event) {
      const appended = normalizeAndAppendEvent(merged, event);
      Object.assign(merged, appended);
    }
    writeJobFile(workspaceRoot, jobId, merged);
    upsertCompactJobIndexEntry(workspaceRoot, merged);
    return { job: merged, eventRecorded: Boolean(event) };
  });
}
```

- [ ] **Step 2: Export `normalizeAndAppendEvent` from `job-observability.mjs`**

Extract the body of the existing `recordJobEvent` (the part that builds `normalizedEvent`, appends to `events`, and computes the `patch` with `lastHeartbeatAt` / progress / diagnostic / completion / cancellation fields) into a pure function:

```js
export function normalizeAndAppendEvent(job, event) {
  const timestamp = event?.timestamp ?? new Date().toISOString();
  const normalizedEvent = sanitizeEvent(event, timestamp);
  const persistedTimestamp = normalizedEvent.timestamp;
  const events = [
    ...(Array.isArray(job.events) ? job.events : []),
    normalizedEvent
  ].slice(-MAX_JOB_EVENTS);

  const patch = {
    events,
    lastHeartbeatAt: persistedTimestamp,
    updatedAt: new Date().toISOString()
  };
  // ... paste the existing isProgressEvent / model_text_chunk / tool_call /
  // isDiagnosticEvent / completed / failed / cancelled branches here verbatim
  // from the current recordJobEvent body, writing into `patch` instead of
  // the in-place job.
  return patch;
}
```

Rewrite `recordJobEvent` as a thin wrapper that runs inside `withJobMutex`:

```js
export async function recordJobEvent(workspaceRoot, jobId, event) {
  return withJobMutex(workspaceRoot, jobId, async () => {
    const existing = readJobFile(workspaceRoot, jobId);
    if (!existing) return null;
    const patch = normalizeAndAppendEvent(existing, event);
    const nextJob = { ...existing, ...patch };
    writeJobFile(workspaceRoot, jobId, nextJob);
    upsertCompactJobIndexEntry(workspaceRoot, nextJob);
    return nextJob;
  });
}
```

Keep the public signature unchanged — all existing callers now `await`.

- [ ] **Step 3: Swap call sites in `tracked-jobs.mjs`**

Replace every `writeJobFile(...) + upsertCompactJobIndexEntry(...) + safeRecordJobEvent(...)` sequence in `runTrackedJob`, `updateJobPhase`, and `markTrackedJobCancelled` with a single `persistJobStateAndEvent`. `markTrackedJobCancelled` returns the new shape `{ job, eventRecorded }`.

- [ ] **Step 4: Extend `compactJobIndexEntry` to include `errorMessage` and `summary`**

```js
function compactJobIndexEntry(job) {
  return {
    // ... existing fields ...
    summary: job.summary,
    errorMessage: job.errorMessage
  };
}
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit chunk 3**

```bash
git add plugins/gemini/scripts/lib/tracked-jobs.mjs plugins/gemini/scripts/lib/job-observability.mjs tests/
git commit -m "fix: persist lifecycle and events in one atomic cycle"
```

---

## Chunk 4: Sticky Diagnostic Health (fixes C1)

### Task 4.1: Failing test

- [ ] **Step 1: Extend `tests/job-control.test.mjs`**

```js
test("classifyRuntimeHealth preserves persisted rate_limited status", () => {
  const ws = makeTempDir();
  initGitRepo(ws);
  const job = createTrackedJob({ workspaceRoot: ws, kind: "task", title: "t" });
  // Simulate a stored rate-limit diagnostic with recent progress.
  writeJobFile(ws, job.id, {
    ...readJobFile(ws, job.id),
    status: "running",
    healthStatus: "rate_limited",
    healthMessage: "quota",
    recommendedAction: "switch models",
    lastProgressAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString()
  });
  const snap = buildStatusSnapshot(ws, { isProcessAlive: () => true });
  const running = snap.running.find((j) => j.id === job.id);
  assert.equal(running.healthStatus, "rate_limited");
  assert.equal(running.healthMessage, "quota");
});
```

- [ ] **Step 2: RED**

Run: `node --test tests/job-control.test.mjs`
Expected: FAIL — current code reclassifies to `active`.

### Task 4.2: Preserve diagnostic statuses in `classifyRuntimeHealth`

- [ ] **Step 1: Patch `job-control.mjs`**

```js
const DIAGNOSTIC_HEALTH_STATUSES = new Set([
  "rate_limited", "auth_required", "broker_unhealthy", "failed", "worker_missing"
]);

function classifyRuntimeHealth(job, options = {}) {
  if (job.status !== "running" && job.status !== "queued") return {};
  const nowMs = parseTime(options.now) ?? Date.now();
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;

  if (job.pid && !isProcessAlive(job.pid)) {
    return {
      healthStatus: "worker_missing",
      healthMessage: "Worker process is no longer running.",
      recommendedAction: "Check /gemini:result or /gemini:status, then retry if the result is incomplete."
    };
  }

  if (DIAGNOSTIC_HEALTH_STATUSES.has(job.healthStatus)) {
    return {
      healthStatus: job.healthStatus,
      healthMessage: job.healthMessage ?? null,
      recommendedAction: job.recommendedAction ?? null
    };
  }

  // ...existing time-based classification unchanged...
}
```

- [ ] **Step 2: GREEN**

Run: `node --test tests/job-control.test.mjs && npm test`
Expected: PASS.

- [ ] **Step 3: Commit chunk 4**

```bash
git add plugins/gemini/scripts/lib/job-control.mjs tests/job-control.test.mjs
git commit -m "fix: preserve diagnostic health in runtime classification"
```

---

## Chunk 5: Event & Diagnostic Hygiene (fixes I1, I2, I3, I4, I8, I9, I10, I11 + constant consolidation)

### Task 5.1: Failing tests

- [ ] **Step 1: Add tests**

```js
// tests/job-observability.test.mjs — additions
test("buildJobEventFromAcpNotification records chars, not model text, for agent_message_chunk", () => {
  const evt = buildJobEventFromAcpNotification({
    params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "secret" } } }
  });
  assert.equal(evt.type, "model_text_chunk");
  assert.equal(evt.chars, 6);
  assert.equal(evt.message, undefined);
});

test("isDiagnosticEvent does not match error_cleared or diagnostic_acknowledged", () => {
  assert.equal(isDiagnosticEvent({ type: "error_cleared" }), false);
  assert.equal(isDiagnosticEvent({ type: "diagnostic_acknowledged" }), false);
  assert.equal(isDiagnosticEvent({ type: "diagnostic" }), true);
  assert.equal(isDiagnosticEvent({ type: "diagnostic_quota" }), true);
});

test("sanitizeEvent passes through numeric and boolean whitelisted fields", () => {
  const e = sanitizeEvent({ type: "model_text_chunk", chars: 42, final: true }, "2026-04-18T00:00:00Z");
  assert.equal(e.chars, 42);
  assert.equal(e.final, true);
});
```

```js
// tests/acp-diagnostics.test.mjs — additions
test("buildBrokerDiagnosticNotification sanitizes and bounds source", () => {
  const n = buildBrokerDiagnosticNotification({
    source: "\u001b[31mmal\u0000icious" + "x".repeat(1000),
    message: "ok"
  });
  assert.ok(!n.params.source.includes("\u001b"));
  assert.ok(!n.params.source.includes("\u0000"));
  assert.ok(n.params.source.length <= 500);
});

test("stderr collector emits [truncated diagnostic] on line-less flood", () => {
  const messages = [];
  const collector = createStderrDiagnosticCollector((m) => messages.push(m));
  collector.feed("x".repeat(10_000));
  assert.ok(messages.some((m) => m.includes("[truncated diagnostic]")));
});
```

```js
// tests/acp-client.test.mjs — addition
test("handleChunk emits synthetic acp-transport diagnostic on line-buffer overflow", () => {
  const client = Object.assign(new FakeClient("direct"), { pending: new Map(), nextId: 1, lineBuffer: "" });
  client.handleChunk = AcpClientBase.prototype.handleChunk.bind(client);
  client.handleChunk("y".repeat((1 << 20) + 1000));
  assert.ok(client.diagnostics.some((d) => d.source === "acp-transport"));
});
```

- [ ] **Step 2: RED**

Run: `npm test`
Expected: new assertions fail.

### Task 5.2: Implement fixes

- [ ] **Step 1: `acp-diagnostics.mjs` — sanitize source, flood marker**

```js
export function buildBrokerDiagnosticNotification({ source, message }) {
  const sanitizedSource = sanitizeDiagnosticMessage(source ?? "broker") || "broker";
  return {
    jsonrpc: "2.0",
    method: BROKER_DIAGNOSTIC_METHOD,
    params: {
      source: sanitizedSource,
      message: sanitizeDiagnosticMessage(message)
    }
  };
}

export function createStderrDiagnosticCollector(emit) {
  let pending = "";
  return {
    feed(chunk) {
      pending += typeof chunk === "string" ? chunk : String(chunk ?? "");
      let newlineIndex;
      while ((newlineIndex = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        const sanitized = sanitizeDiagnosticMessage(line);
        if (sanitized) {
          try { emit(sanitized); } catch { /* best-effort */ }
        }
      }
      if (pending.length > MAX_DIAGNOSTIC_LENGTH * 4) {
        pending = "";
        try { emit("[truncated diagnostic]"); } catch { /* best-effort */ }
      }
    },
    flush() {
      if (pending.trim()) {
        const sanitized = sanitizeDiagnosticMessage(pending);
        pending = "";
        if (sanitized) {
          try { emit(sanitized); } catch { /* best-effort */ }
        }
      }
    }
  };
}
```

- [ ] **Step 2: `job-observability.mjs` — consolidate constant, tighten matchers, sanitize passthrough**

```js
import { MAX_DIAGNOSTIC_LENGTH } from "./acp-diagnostics.mjs";

// remove local `export const MAX_DIAGNOSTIC_LENGTH = 500;`

function isDiagnosticEvent(event) {
  const type = String(event.type ?? "");
  return DIAGNOSTIC_EVENT_TYPES.has(type)
    || type.startsWith("diagnostic_")
    || type.startsWith("error_");
}

function sanitizeEvent(event, timestamp) {
  const input = event && typeof event === "object" ? event : {};
  const normalized = { timestamp: sanitizeText(timestamp) };
  for (const [key, value] of Object.entries(input)) {
    if (!SAFE_EVENT_FIELDS.has(key)) continue;
    if (typeof value === "string") normalized[key] = sanitizeText(value);
    else if (typeof value === "number" && Number.isFinite(value)) normalized[key] = value;
    else if (typeof value === "boolean") normalized[key] = value;
    // nulls/objects/arrays ignored.
  }
  return normalized;
}

// Add "chars" to SAFE_EVENT_FIELDS
const SAFE_EVENT_FIELDS = new Set([
  "type", "timestamp", "message", "phase", "toolName",
  "path", "action", "source", "transport", "chars"
]);
```

- [ ] **Step 3: `gemini.mjs` — agent_message_chunk stores chars only**

```js
if (kind === "agent_message_chunk") {
  const text = update.content?.text ?? "";
  return { type: "model_text_chunk", chars: text.length };
}
```

- [ ] **Step 4: `acp-client.mjs` — overflow diagnostic**

```js
import { sanitizeDiagnosticMessage } from "./acp-diagnostics.mjs";

handleChunk(chunk) {
  this.lineBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = this.lineBuffer.indexOf("\n")) !== -1) {
    const line = this.lineBuffer.slice(0, newlineIndex);
    this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
    this.handleLine(line);
  }
  if (this.lineBuffer.length > ACP_MAX_LINE_BUFFER) {
    const dropped = this.lineBuffer.length - ACP_MAX_LINE_BUFFER;
    this.lineBuffer = this.lineBuffer.slice(-ACP_MAX_LINE_BUFFER);
    if (this.onDiagnostic) {
      try {
        this.onDiagnostic({
          source: "acp-transport",
          message: sanitizeDiagnosticMessage(`[line buffer overflow — dropped ${dropped} bytes]`)
        });
      } catch { /* best-effort */ }
    }
  }
}
```

- [ ] **Step 5: `acp-broker.mjs` — cap client line buffer + ring stores pre-built notifications**

In `handleClientConnection`:
```js
let lineBuffer = "";
socket.on("data", (chunk) => {
  lineBuffer += chunk;
  let newlineIndex;
  while ((newlineIndex = lineBuffer.indexOf("\n")) !== -1) {
    const line = lineBuffer.slice(0, newlineIndex);
    lineBuffer = lineBuffer.slice(newlineIndex + 1);
    handleClientMessage(socket, line);
  }
  if (lineBuffer.length > ACP_MAX_LINE_BUFFER) {
    lineBuffer = lineBuffer.slice(-ACP_MAX_LINE_BUFFER);
  }
});
```

Update `forwardDiagnosticToActiveClient` and `drainDiagnosticRingTo`:
```js
function forwardDiagnosticToActiveClient(source, message) {
  const notification = buildBrokerDiagnosticNotification({ source, message });
  if (activeClient && !activeClient.destroyed) {
    send(activeClient, notification);
  } else {
    rememberDiagnostic(notification);
  }
}

function drainDiagnosticRingTo(socket) {
  if (diagnosticRing.length === 0 || !socket || socket.destroyed) return;
  for (const notification of diagnosticRing) {
    send(socket, notification);
  }
  diagnosticRing.length = 0;
}
```

Import `ACP_MAX_LINE_BUFFER` from `acp-client.mjs`.

- [ ] **Step 6: GREEN**

Run: `npm test`
Expected: PASS (all new tests).

- [ ] **Step 7: Commit chunk 5**

```bash
git add plugins/gemini/scripts/lib/acp-diagnostics.mjs plugins/gemini/scripts/lib/job-observability.mjs plugins/gemini/scripts/lib/gemini.mjs plugins/gemini/scripts/lib/acp-client.mjs plugins/gemini/scripts/acp-broker.mjs tests/
git commit -m "fix: harden event and diagnostic hygiene"
```

---

## Chunk 6: Docs, Skills, and Terminal Labels (fixes I5, I6)

### Task 6.1: Failing tests

- [ ] **Step 1: Extend `tests/commands.test.mjs`**

Add `completed` and `cancelled` to the labels list:
```diff
 const labels = [
   "active", "quiet", "possibly_stalled",
   "rate_limited", "auth_required", "broker_unhealthy",
-  "worker_missing", "failed"
+  "worker_missing", "failed",
+  "completed", "cancelled"
 ];
```

And add to the README matcher block:
```js
assert.match(readme, /completed/);
assert.match(readme, /cancelled/);
```

- [ ] **Step 2: Extend `tests/render.test.mjs`**

```js
test("renderSingleJobStatus includes runtime.transport when present", () => {
  const output = renderSingleJobStatus({
    workspaceRoot: "/tmp/x",
    job: {
      id: "j1", kind: "task", status: "running", title: "t",
      runtime: { transport: "broker" },
      events: []
    }
  });
  assert.match(output, /## Runtime/);
  assert.match(output, /broker/);
});
```

- [ ] **Step 3: RED**

Run: `node --test tests/commands.test.mjs tests/render.test.mjs`
Expected: FAIL.

### Task 6.2: Implement docs + renderer

- [ ] **Step 1: `README.md` — add rows**

```
| `cancelled` | The job was cancelled by the user or runtime. | No further action unless you want to retry. |
| `completed` | The job finished successfully. | Fetch output with `/gemini:result <job-id>`. |
```

- [ ] **Step 2: `gemini-cli-runtime/SKILL.md` — add rows**

```
| `completed` | Gemini finished successfully. | Fetch `/gemini:result` and present output; do not retry. |
| `cancelled` | Job was cancelled by user or system. | Fetch `/gemini:result` for final diagnostics; consider retrying if needed. |
```

- [ ] **Step 3: `render.mjs` — render transport in the Runtime section**

```js
if (job.runtime?.transport) {
  lines.push(`- **Transport:** ${job.runtime.transport}`);
}
```

- [ ] **Step 4: GREEN**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit chunk 6**

```bash
git add README.md plugins/gemini/skills/gemini-cli-runtime/SKILL.md plugins/gemini/scripts/lib/render.mjs tests/commands.test.mjs tests/render.test.mjs
git commit -m "docs: add completed and cancelled terminal health labels"
```

---

## Final Verification and PR Update

- [ ] **Step 1: Run full suite**

Run: `npm test`
Expected: PASS (all new tests + existing 76 still green).

- [ ] **Step 2: Inspect the diff vs origin/main**

```bash
git diff origin/main...HEAD --stat
git log --oneline origin/main..HEAD
```

Check for:
- No sensitive files staged.
- No raw stderr/prompts/credentials persisted in job state.
- No daemon/watchdog behavior added.

- [ ] **Step 3: Push additional commits to PR #16**

```bash
git push origin issue-14-job-observability-impl
```

- [ ] **Step 4: Post a PR comment summarizing what changed**

Use `gh pr comment 16` with a checklist mapping each Critical/Important finding to the commit that addressed it. Link the hardening spec and plan docs.
