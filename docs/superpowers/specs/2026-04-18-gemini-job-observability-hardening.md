# Gemini Job Observability Hardening Design

## Context

PR #16 landed the lightweight Gemini job observability layer (issue #14). Six reviewers (Codex PR bot, CodeRabbit, Superpowers, ECC TypeScript, Gemini pro, and an initial `code-reviewer` pass) surfaced a consolidated set of findings that fall into three themes: concurrency correctness, trust-boundary hardening for diagnostics, and correctness/UX fixes around status classification and persistence.

This spec covers the follow-up fixes that ship as additional commits on PR #16.

## Goal

Close every Critical and Important finding before PR #16 merges, without introducing a watchdog daemon, supervisor, or cross-process lock dependency. Preserve the public surface of the observability layer introduced in PR #16.

## Non-Goals

- Cross-process file locking via `flock` or `proper-lockfile`. An in-process per-jobId mutex plus atomic-rename writes handle the realistic races; cross-process hardening is out of scope.
- Event journaling or log-structured storage. Read-modify-write stays, made safe with mutex + atomic rename.
- Broker auth/signing via shared secrets. Transport-level trust gating is sufficient.
- Rewriting command contracts, CLI flags, or rendered output schema.

## Findings to Close

### Critical
- **C1** — `classifyRuntimeHealth` clobbers persisted diagnostic statuses.
- **C2** — Broker-diagnostic forgery: direct-mode child can emit `broker/diagnostic` on stdout.
- **C3** — Broker diagnostics double-recorded: client dispatches to both `onDiagnostic` and `onNotification`.
- **C4** — `runTrackedJob` lifecycle path silently clears `summary` from the compact index.
- **C5** — `recordJobEvent` non-atomic read-modify-write race between two producers.
- **C6** — `saveState` prune race can unlink another in-flight job's `.json`/`.log`.

### Important
- **I1** — Raw model output stored as event message (privacy risk in `/gemini:status`).
- **I2** — `diagnosticRing` stores raw-length messages.
- **I3** — `isDiagnosticEvent` uses substring match that mis-triggers on `error_cleared` etc.
- **I4** — `buildBrokerDiagnosticNotification` does not sanitize `source`.
- **I5** — Renderer drops `runtime.transport`; test didn't catch it.
- **I6** — `completed` and `cancelled` missing from README, SKILL, commands.test.
- **I7** — `markTrackedJobCancelled` returns stale data on event-record failure.
- **I8** — `sanitizeEvent` drops non-string whitelisted fields silently.
- **I9** — `handleClientConnection` lineBuffer uncapped.
- **I10** — Flood tail-keep + head-sanitize emits mid-line garbage.
- **I11** — ACP line-buffer overflow silently drops data — emit synthetic `acp-transport` diagnostic.
- **I12** — `compactJobIndexEntry` omits `errorMessage`.

## Approach

### Concurrency (C5, C6)

Introduce `plugins/gemini/scripts/lib/atomic-state.mjs` with:

- `withJobMutex(workspaceRoot, jobId, fn)` — promise-chain mutex keyed by `${workspaceRoot}:${jobId}`. Writers of the same job serialize; different jobs proceed in parallel.
- `withWorkspaceMutex(workspaceRoot, fn)` — similar mutex keyed by workspace, guarding `state.json` writes in `saveState`.
- `writeJsonAtomic(path, value)` — writes to `<path>.tmp.<random>` then `fs.renameSync` to `<path>`. On POSIX the rename is atomic; on Windows it's close enough for our guarantees.

Integrate into `state.mjs` (`writeJobFile`, `saveState`) and `job-observability.mjs` (`recordJobEvent`, `upsertCompactJobIndexEntry`). All writes go through the atomic helper; all read-modify-write sequences execute inside the appropriate mutex.

### Trust Boundary (C2, C3)

In `AcpClientBase.handleLine`:

- Route `broker/diagnostic` through `onDiagnostic` **only when** `this.transport === "broker"`.
- Do **not** also forward to `onNotification` in that branch; the diagnostic path is the single dispatcher.
- In direct mode, a `broker/diagnostic` notification from stdout is treated as a regular (non-model) notification and handled by the existing fallthrough path. The model cannot fabricate trusted broker diagnostics.

In `gemini.mjs` `runAcpPrompt`, remove the upstream guard on `BROKER_DIAGNOSTIC_METHOD` in `notificationHandler` since the client now guarantees single-dispatch.

### Lifecycle Persistence (C4)

Introduce in `tracked-jobs.mjs` a single helper `persistJobStateAndEvent(workspaceRoot, jobId, patch, eventOptions)`:

- Inside `withJobMutex(workspaceRoot, jobId, ...)`:
  - Read current job file.
  - Compute `merged = { ...existing, ...patch }`.
  - Append event via `recordJobEvent`'s normalization (or a shared internal routine) to `merged.events`.
  - `writeJsonAtomic` the merged job file.
  - `upsertCompactJobIndexEntry(workspaceRoot, merged)` (single consistent view including `summary` and `errorMessage`).
- Replace every place in `runTrackedJob`, `updateJobPhase`, and `markTrackedJobCancelled` that did `writeJobFile` + `upsertCompactJobIndexEntry` + `safeRecordJobEvent` with a single call to this helper.

`compactJobIndexEntry` gains `errorMessage` and `summary` (I12 and C4).

`markTrackedJobCancelled` returns `{ job, eventRecorded }` instead of raw `nextJob` (I7).

### Sticky Diagnostic (C1)

In `job-control.mjs` `classifyRuntimeHealth`:

- Define `DIAGNOSTIC_HEALTH_STATUSES = new Set(["rate_limited", "auth_required", "broker_unhealthy", "failed", "worker_missing"])`.
- After the PID-liveness check, if `DIAGNOSTIC_HEALTH_STATUSES.has(job.healthStatus)`, return the persisted `{ healthStatus, healthMessage, recommendedAction }` unchanged.
- Only fall through to time-based active/quiet/possibly_stalled when the stored health is absent or is already a time-derived label (`active`, `quiet`, `possibly_stalled`) or a terminal label (`completed`, `cancelled`).
- Explicit recovery is out of scope for this PR: a future change can add an event type (e.g. `rate_limit_cleared`) that resets `healthStatus` in `recordJobEvent` before this preservation rule sees it.

### Event Hygiene (I1, I3, I8)

- `buildJobEventFromAcpNotification` for `agent_message_chunk` records `{ type: "model_text_chunk", chars: <count> }` — no text body. Other mappings remain unchanged (paths and tool names are metadata, not content).
- `isDiagnosticEvent` uses exact membership plus `startsWith("diagnostic_")` / `startsWith("error_")` prefixes.
- `sanitizeEvent` keeps whitelisted keys when type is `string`, `number`, `boolean`, or `null`. Strings are sanitized; other scalars pass through; objects/arrays are dropped.

### Diagnostic Pipeline (I2, I4, I10, I11)

- `buildBrokerDiagnosticNotification` sanitizes and bounds `source` via `sanitizeDiagnosticMessage` (fallback to `"broker"` on empty).
- `rememberDiagnostic` receives already-sanitized `{ source, message }` entries; ring stores the prebuilt notification payload, so replay is a pass-through.
- `createStderrDiagnosticCollector` overflow behaviour changes: when `pending` exceeds `MAX_DIAGNOSTIC_LENGTH * 4` without a newline, emit a single `"[truncated diagnostic]"` message, reset `pending`, keep draining. No mid-line garbage.
- `AcpClientBase.handleChunk` overflow emits a single synthetic `onDiagnostic({ source: "acp-transport", message: "[line buffer overflow — dropped N bytes]" })` before truncating.
- `handleClientConnection` in `acp-broker.mjs` gains the same `ACP_MAX_LINE_BUFFER` cap as `AcpClientBase`.

### Constant Consolidation

`MAX_DIAGNOSTIC_LENGTH` lives in `acp-diagnostics.mjs` only. `job-observability.mjs` imports it from there. `acp-client.mjs` already imports `sanitizeDiagnosticMessage` from the same module — no new surface.

### Documentation / Skill / Test Updates (I5, I6)

- README.md and `gemini-cli-runtime/SKILL.md` gain rows for `completed` and `cancelled`.
- `commands.test.mjs` health-labels regression list gains `completed` and `cancelled`.
- `render.mjs` `renderSingleJobStatus` includes `runtime.transport` in the Runtime section.
- `tests/render.test.mjs` fixture includes `runtime.transport` and asserts it renders.

## Testing (TDD)

Per finding / helper, write failing tests first, then implement.

- `tests/atomic-state.test.mjs` (new): concurrent `withJobMutex` serialization; `writeJsonAtomic` leaves no partial file on rename; behaves correctly under concurrent writers to same and different keys.
- `tests/job-observability.test.mjs`:
  - Two concurrent `recordJobEvent` calls on the same job preserve both events (no drops).
  - `recordJobEvent` survives a corrupted partial read (treat as empty events).
  - `sanitizeEvent` passes numeric/boolean whitelisted fields through.
  - `isDiagnosticEvent` does not match `error_cleared` / `diagnostic_acknowledged`.
  - `buildJobEventFromAcpNotification` for `agent_message_chunk` does not include the text body.
- `tests/state.test.mjs`:
  - Concurrent `saveState` writers never delete another writer's job file.
  - `compactJobIndexEntry` includes `errorMessage` and `summary` when present.
- `tests/acp-diagnostics.test.mjs`:
  - `buildBrokerDiagnosticNotification` sanitizes `source`.
  - Stderr flood without newline emits `[truncated diagnostic]` and resets pending.
- `tests/acp-client.test.mjs` (new or extend): direct-mode `broker/diagnostic` stdout line is NOT delivered to `onDiagnostic`; broker-mode delivery works; line-buffer overflow emits synthetic `acp-transport` diagnostic; `handleLine` does not double-dispatch.
- `tests/job-control.test.mjs`: sticky diagnostic preserved when job has `rate_limited`; falls through to `active` only when stored status is time-derived or absent.
- `tests/render.test.mjs`: Runtime section includes `transport` value.
- `tests/commands.test.mjs`: label list includes `completed` and `cancelled`.
- `tests/tracked-jobs.test.mjs` (or extend): on completion, compact index keeps `summary` and (on failure path) `errorMessage`; `markTrackedJobCancelled` returns `{ job, eventRecorded }`.

## Rollout

Additional commits on PR #16, one commit per theme:

1. `feat: atomic job state writes with per-job mutex` (C5, C6 + helper).
2. `fix: gate broker diagnostics by transport and single-dispatch` (C2, C3).
3. `fix: persist lifecycle and events in one atomic cycle` (C4, I7, I12 — and the double-write nit).
4. `fix: preserve diagnostic health in runtime classification` (C1).
5. `fix: harden event and diagnostic hygiene` (I1, I2, I3, I4, I8, I10, I11, I9, MAX_DIAGNOSTIC_LENGTH consolidation).
6. `docs: add completed and cancelled terminal health labels` (I5, I6).

## Approval

Approved by the user on 2026-04-18 after consolidating findings from Codex PR bot, CodeRabbit, Superpowers, ECC TypeScript, and Gemini pro adversarial reviews.
