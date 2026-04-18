# Gemini Job Observability Design

## Context

Issue 14 asks for better observability for long-running Gemini background jobs. Today `/gemini:status` can show a job as `running` even when the useful question is whether the detached worker, ACP broker, Gemini ACP session, streamed model output, quota/backoff path, or runtime diagnostics are still healthy.

The current code stores coarse job lifecycle state in `tracked-jobs.mjs`, collects ACP notifications in memory in `gemini.mjs`, drains direct ACP stderr in `acp-client.mjs`, drains broker ACP child stderr in `acp-broker.mjs`, and renders status from job index fields in `render.mjs` and `job-control.mjs`.

## Goal

Add lightweight job observability that lets users tell whether a Gemini job is active, quiet, possibly stalled, rate limited, blocked by authentication, affected by broker/runtime problems, or failed, without introducing a heavy supervisor or watchdog daemon.

## Non-Goals

- Do not add a separate monitoring daemon, polling watchdog, or aggressive process supervisor.
- Do not auto-cancel quiet jobs.
- Do not stream full Gemini output into status output by default.
- Do not persist secrets, full prompts, raw credentials, or unbounded stdout/stderr.
- Do not require `/gemini:status` to parse log files to derive normal health state.

## Approach

Implement the issue's recommended Option B as a focused first PR. The implementation will add one small observability helper module and persist bounded events plus derived liveness fields on each job. Runtime code will emit events at natural boundaries: worker lifecycle, phase changes, ACP connection selection, session creation/load, ACP notifications, model text chunks, tool calls, file changes, stderr diagnostics, broker fallback, and errors.

Health classification will remain conservative. Explicit diagnostics can produce statuses such as `rate_limited`, `auth_required`, `broker_unhealthy`, `worker_missing`, or `failed`. Quiet jobs can be labeled `quiet` or `possibly_stalled` based on missing recent progress, but status copy must avoid claiming a job is dead without strong evidence.

## Data Model

Each job file can include:

- `events`: bounded recent event list.
- `lastHeartbeatAt`
- `lastProgressAt`
- `lastModelOutputAt`
- `lastToolCallAt`
- `lastDiagnosticAt`
- `healthStatus`
- `healthMessage`
- `recommendedAction`
- `runtime`: bounded runtime details such as transport, broker endpoint, direct fallback reason, and session id.

Each event has:

- `timestamp`
- `type`
- `message`
- optional `data` payload safe for status and JSON output.

Event retention should be capped, likely 25 to 50 events per job. Derived fields are updated when events are appended so renderers can read them directly.

## Components

### `plugins/gemini/scripts/lib/job-observability.mjs`

Own event normalization, retention, diagnostic classification, health derivation, and job-file/index updates. It should be small and independent of ACP implementation details.

Public helpers should cover:

- append an event to a job
- update health from an event
- classify stderr or error text
- format relative last-progress data for renderers if needed

### `plugins/gemini/scripts/lib/tracked-jobs.mjs`

Initialize observability fields when a job is created or enters `running`. Emit events for worker start, phase changes, completion, cancellation, and failure.

### `plugins/gemini/scripts/lib/gemini.mjs`

Accept an optional job observer/context in ACP prompt/review functions. Emit events for ACP session operations, notifications, text chunks, tool calls, file changes, and returned errors.

### `plugins/gemini/scripts/lib/acp-client.mjs`

Expose bounded direct stderr diagnostics through an optional callback instead of only draining stderr. Report broker connection outcomes and direct fallback reasons through callbacks. Keep the client transport-agnostic for callers by attaching transport/runtime details to the returned client.

### `plugins/gemini/scripts/acp-broker.mjs`

Capture bounded stderr diagnostics from the broker-managed `gemini --acp` child instead of only draining stderr. When a client owns the active request, forward safe diagnostic notifications to that active client using a broker-specific JSON-RPC notification method that the client treats as diagnostic data rather than ACP model output. If no client is active, retain only a small in-memory ring or broker log entry and do not attach it to an unrelated future job.

Broker child process exit and readiness failures should also produce bounded diagnostics for the active client when possible. This keeps broker-managed and direct-spawn diagnostics observable without adding a separate supervisor.

### `plugins/gemini/scripts/lib/job-control.mjs`

Enrich status snapshots with stored observability fields and recent events. Add conservative stale/quiet classification during snapshot building if a running job has not emitted recent progress.

Add a status-time worker PID check for running jobs where platform support allows it. If a job is still marked `running` but its recorded worker PID is missing or no longer alive, expose a conservative `worker_missing` health status and recommended action. This check should not require a polling daemon; it runs only while building status snapshots.

### `plugins/gemini/scripts/lib/render.mjs`

Add `Health` and `Last Progress` to the active jobs table. Add detailed health, runtime, timestamps, recent events, diagnostics, and recommended action to single-job status output.

### Documentation and Skills

Update:

- `README.md` to describe health labels, last-progress data, diagnostics, and recommended next actions in `/gemini:status`.
- `plugins/gemini/commands/status.md` so slash-command rendering preserves the new fields.
- `plugins/gemini/skills/gemini-cli-runtime/SKILL.md` so agents interpret health/progress fields correctly.
- `plugins/gemini/skills/gemini-result-handling/SKILL.md` if status health affects wait, retry, cancel, or result-fetch guidance.

## User Experience

Active job status should stay compact:

```text
| Job ID | Kind | Status | Health | Last Progress | Elapsed | Summary |
```

Detailed job status should include:

- lifecycle status and phase
- health status and message
- elapsed time
- worker PID if known
- transport/runtime state
- Gemini session ID if known
- last heartbeat/progress/model output/tool call/diagnostic timestamps
- recent safe events and diagnostics
- recommended next command

Example:

```text
Health: rate_limited
Last progress: 12m ago
Diagnostic: Gemini reported quota or rate limiting and appears to be waiting before retrying.
Try: wait, switch models, or cancel with /gemini:cancel <job-id>
```

## Testing

Use TDD. Add focused tests for:

- event retention and derived liveness fields
- diagnostic classification for rate limit, quota, auth, model unavailable, network/API, broker busy/unavailable, and ACP exit messages
- broker-managed child stderr forwarding as bounded diagnostics to the active job
- ACP notification-to-event mapping for model text, tool calls, and file changes
- status snapshot enrichment with health, timestamps, runtime, and recent events
- status-time worker PID classification for missing or stale running workers, where platform support allows it
- active table rendering with `Health` and `Last Progress`
- detailed job status rendering with diagnostics and recommended action
- bounded direct stderr diagnostics without leaking unbounded raw stderr

Run the full test suite before claiming completion:

```bash
npm test
```

## Approval

Approved by the user on 2026-04-18 with the added requirement to update relevant skills and README documentation. The approved scope is the lightweight Option B implementation, not a full watchdog/supervisor.
