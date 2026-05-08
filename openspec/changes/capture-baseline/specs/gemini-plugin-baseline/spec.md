# gemini-plugin-baseline

Frozen contract for `gemini-plugin-cc` sampled at commit `f8f773c` on `main`. The capability captures as-is behavior (including known warts) so future changes can author `## MODIFIED Requirements` against a stable diff base. The captured JSON output shape is flat (top-level keys, no `schemaVersion` field); renaming to a nested shape with a `schemaVersion` field is the responsibility of `delegate-plugin-cli-schema/v1` (see `align-gemini-plugin-cli-schema-with-codex`), not this capability.

## ADDED Requirements

### Requirement: CLI Surface

The plugin SHALL expose seven user-facing slash commands and three internal subcommands at commit `f8f773c`. User-facing commands are `setup`, `review`, `adversarial-review`, `rescue`, `status`, `result`, and `cancel`. Internal subcommands (used by the runtime, not advertised in `--help` for end users at this baseline) are `task`, `task-worker`, and `task-resume-candidate`. The companion entry point is `plugins/gemini/scripts/gemini-companion.mjs`. The `rescue` slash command does NOT have a companion CLI handler at this baseline — it is invoked via the host's Task tool against the `gemini-rescue` subagent.

#### Scenario: Listing user-facing commands

- **GIVEN** the plugin checked out at commit `f8f773c`
- **WHEN** a reader inspects `plugins/gemini/commands/`
- **THEN** the directory contains exactly seven `.md` files: `setup.md`, `review.md`, `adversarial-review.md`, `rescue.md`, `status.md`, `result.md`, `cancel.md`

#### Scenario: Internal subcommands present in companion dispatch

- **GIVEN** `plugins/gemini/scripts/gemini-companion.mjs` at commit `f8f773c`
- **WHEN** the dispatcher's `switch` block (around lines 730-750) is read
- **THEN** it routes the case labels `task`, `task-worker`, and `task-resume-candidate` to their respective handlers

### Requirement: Command Flag Taxonomy

The plugin SHALL accept exactly the following per-command flags at commit `f8f773c` (sourced from each handler's `parseCommandInput(argv, { valueOptions, booleanOptions })` schema). Flags listed under `valueOptions` take a string value; flags under `booleanOptions` are toggles. Any flag NOT listed for a given command is rejected by the parser as an unknown flag.

- `setup` — boolean: `--json`, `--enable-review-gate`, `--disable-review-gate` (no value flags; no `--cwd` at this baseline)
- `review` — value: `--base`, `--scope`, `--model`, `--cwd`, `--thinking`; boolean: `--json`, `--wait`, `--background`, `--stream-output`
- `adversarial-review` — value: `--base`, `--scope`, `--model`, `--cwd`, `--thinking`; boolean: `--json`, `--wait`, `--background`, `--stream-output` (identical schema to `review`)
- `task` (internal) — value: `--model`, `--approval-mode`, `--cwd`, `--thinking`; boolean: `--json`, `--write`, `--background`, `--wait`, `--resume-last`, `--stream-output`
- `status` — value: `--timeout-ms`, `--cwd`; boolean: `--json`, `--wait`, `--all`
- `result` — value: `--cwd`; boolean: `--json`
- `cancel` — value: `--cwd`; boolean: `--json`
- `task-resume-candidate` (internal) — value: `--cwd`; boolean: `--json`

The `rescue` slash command MUST NOT be expected to accept any of the flags above — it has no companion-side parser at this baseline.

#### Scenario: setup parser rejects --cwd

- **GIVEN** `handleSetup` at `gemini-companion.mjs:172-174` declares `booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]` and no `valueOptions`
- **WHEN** a caller invokes `node gemini-companion.mjs setup --cwd /some/path`
- **THEN** the parser treats `--cwd` as an unknown flag (per `args.mjs:42-50`) and `/some/path` is captured as the value of an unknown option, NOT as a workspace-root override

#### Scenario: review and adversarial-review share identical flag schemas

- **GIVEN** the parser configs at `gemini-companion.mjs:219-222` and `gemini-companion.mjs:262-265`
- **WHEN** a reader compares the two `parseCommandInput` invocations
- **THEN** their `valueOptions` arrays are identical (`["base", "scope", "model", "cwd", "thinking"]`) and their `booleanOptions` arrays are identical (`["json", "wait", "background", "stream-output"]`)

### Requirement: Resume-Last Semantics

The `task --resume-last` flag SHALL look up the most recent task-kind job with a non-null `threadId` in the workspace's job state, sorted by `updatedAt` descending, and seed `sessionId` from that job's `threadId`. The runtime then uses `session/load` (instead of `session/new`) to reattach to the prior ACP session. If no resumable job exists, the runtime emits "No resumable Gemini session found. Starting fresh." to stderr and proceeds with a fresh `session/new`.

#### Scenario: --resume-last seeds sessionId from latest task job

- **GIVEN** the workspace's job state contains task jobs ordered `[T3 (updatedAt 2026-05-08T10:00), T2 (updatedAt 2026-05-08T09:00), T1 (updatedAt 2026-05-08T08:00)]` with non-null `threadId`s
- **WHEN** a caller invokes `node gemini-companion.mjs task --resume-last "follow up"`
- **THEN** `findLatestTaskThread(cwd)` returns `{id: T3.threadId, status: T3.status}` (`lib/gemini.mjs:650-666`); `sessionId` is set to `T3.threadId`; the runtime emits `Resuming Gemini session: <T3.threadId>` to stderr and routes the prompt via `session/load`

#### Scenario: --resume-last with no candidates falls back to fresh session

- **GIVEN** the workspace has no task jobs with a non-null `threadId`
- **WHEN** a caller invokes `node gemini-companion.mjs task --resume-last "do work"`
- **THEN** `findLatestTaskThread` returns `null`; the runtime emits "No resumable Gemini session found. Starting fresh." to stderr; the prompt routes via `session/new` with a fresh `sessionId`

### Requirement: Flag Value Domains

The plugin SHALL accept exactly the following value sets for value-bearing flags at commit `f8f773c`. Values outside these sets MUST be rejected (or coerced) by the runtime before reaching the ACP layer. These domains are the diff base for any v2 work that adds, removes, renames, or aliases values (e.g., the `--thinking` → `--effort` rename in `align-gemini-plugin-cli-schema-with-codex`).

- `--thinking` — exactly `{"off", "low", "medium", "high"}`, sourced from `THINKING_LEVELS` at `lib/thinking.mjs:12`. Maps internally to a numeric thinking budget.
- `--scope` — exactly `{"auto", "working-tree", "branch"}`, sourced from `VALID_SCOPES` at `lib/git.mjs:304`.
- `--approval-mode` — exactly `{"default", "auto_edit", "yolo", "plan"}`, sourced from the ACP protocol type at `lib/acp-protocol.d.ts:69`. Default when `--write` is passed: `"auto_edit"`. Default otherwise: `"default"` (`gemini-companion.mjs:326`).
- `--model` — any key in `MODEL_ALIASES` at `gemini-companion.mjs:104-120`, including the auto-routing aliases (`auto-gemini-3`, `auto-gemini-2.5`), short aliases (`pro`, `flash`, `flash-lite`), Gemini 3.x model IDs (`gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-pro-preview`, `gemini-3-flash-preview`), and Gemini 2.5 model IDs (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`).
- `--base` — any free-form git ref string (no fixed enum); unset values default to `"main"` per `lib/git.mjs` resolution.

#### Scenario: --thinking values pinned to four-element enum

- **GIVEN** `lib/thinking.mjs:12` declares `export const THINKING_LEVELS = ["off", "low", "medium", "high"]`
- **WHEN** a reader inspects every `--thinking` consumer in the runtime
- **THEN** all consumers reference `THINKING_LEVELS` (or hardcode the same four-element set); no fifth value is accepted

#### Scenario: --scope values pinned to three-element enum

- **GIVEN** `lib/git.mjs:304` declares `const VALID_SCOPES = new Set(["auto", "working-tree", "branch"])`
- **WHEN** a caller passes `--scope something-else`
- **THEN** the scope-resolution helper rejects the value or coerces it to `"auto"` (the default); the ACP layer is never reached with an out-of-domain scope

#### Scenario: --approval-mode values pinned to four-element type

- **GIVEN** `lib/acp-protocol.d.ts:69` types `approvalMode` as `"default" | "auto_edit" | "yolo" | "plan"`
- **WHEN** `handleTask` resolves the approval mode (`gemini-companion.mjs:326`)
- **THEN** the resolved value is one of those four strings; `--write` overrides to `"auto_edit"`

#### Scenario: --model maps through MODEL_ALIASES

- **GIVEN** `gemini-companion.mjs:104-120` declares `MODEL_ALIASES` with 13 keys: auto-routing aliases (`auto-gemini-3`, `auto-gemini-2.5`), short aliases (`pro`, `flash`, `flash-lite`), Gemini 3.x model IDs (`gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-pro-preview`, `gemini-3-flash-preview`), Gemini 2.5 model IDs (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`)
- **WHEN** `resolveModel(options.model)` is called with one of those keys
- **THEN** the returned value is the corresponding map value; aliases like `pro` resolve to `gemini-3.1-pro-preview` while concrete IDs resolve to themselves; an unknown alias falls through to a default model resolution (no implicit acceptance of arbitrary strings as model IDs)

### Requirement: JSON Output Shape

The plugin SHALL emit flat-shape JSON for `setup --json`, `status --json`, `result --json`, `cancel --json`, and `task --json` outputs at commit `f8f773c`. The setup payload contains the keys `geminiAvailable`, `geminiVersion`, `authenticated`, `authMethod`, `npmAvailable`, `reviewGate`, `message`. The task payload contains `rawOutput`, `fileChanges`, `toolCalls`, `sessionId`. There is no top-level `schemaVersion` field. The future rename to a nested shape (`gemini.available`, `auth.loggedIn`, etc.) with a `schemaVersion: "v1"` field is out of scope for this baseline and is introduced separately by `align-gemini-plugin-cli-schema-with-codex` via the `delegate-plugin-cli-schema/v1` capability.

#### Scenario: setup --json emits flat top-level keys

- **GIVEN** the runtime at commit `f8f773c` with a working Gemini CLI on `PATH`
- **WHEN** a caller invokes `node gemini-companion.mjs setup --json`
- **THEN** the JSON output's top-level keys are exactly `{geminiAvailable, geminiVersion, authenticated, authMethod, npmAvailable, reviewGate, message}` and no `schemaVersion` key is present

#### Scenario: task --json emits rawOutput

- **GIVEN** a foreground `task` invocation completes successfully
- **WHEN** the companion writes its JSON payload to stdout
- **THEN** the payload contains a `rawOutput` field whose value is the rendered Gemini text (verifiable at `gemini-companion.mjs:397`)

#### Scenario: status --json emits workspace + jobs envelope

- **GIVEN** the runtime at commit `f8f773c` with state files on disk for the active workspace
- **WHEN** a caller invokes `node gemini-companion.mjs status --json` (no positional)
- **THEN** the JSON output's top-level keys are exactly `{workspaceRoot, config, runtimeStatus, running, latestFinished, recent, needsReview}` (sourced from `buildStatusSnapshot` in `lib/job-control.mjs:202-233`); `running` and `recent` are arrays of job records; no top-level `schemaVersion` key is present

#### Scenario: status --json runtimeStatus sub-shape

- **GIVEN** the runtime at commit `f8f773c`
- **WHEN** `getSessionRuntimeStatus(env, cwd)` is invoked during status snapshot construction (`lib/gemini.mjs:264-271`)
- **THEN** the returned `runtimeStatus` value has exactly the keys `{brokerRunning, endpoint}` with types `{boolean, string | null}`; `brokerRunning` reflects `Boolean(loadBrokerSession(cwd))`; `endpoint` is sourced first from the persisted broker session, then from `BROKER_ENDPOINT_ENV`, then from `process.env[BROKER_ENDPOINT_ENV]`, falling through to `null`

#### Scenario: result --json emits per-job snapshot

- **GIVEN** the runtime at commit `f8f773c` with a finished job `<job-id>` in state
- **WHEN** a caller invokes `node gemini-companion.mjs result --json <job-id>`
- **THEN** the JSON output's top-level keys are exactly `{jobId, status, threadId, result, rendered}` (sourced from `handleResult` in `gemini-companion.mjs:561-568`); no `schemaVersion` key is present

#### Scenario: result --json with unknown id throws (not JSON envelope)

- **GIVEN** the runtime at commit `f8f773c`
- **WHEN** a caller invokes `node gemini-companion.mjs result --json <unknown-id>`
- **THEN** `resolveResultJob` throws (`lib/job-control.mjs:271-280`), the process exits non-zero, the error message lands on stderr, and no JSON is written to stdout

#### Scenario: cancel --json emits cancellation snapshot

- **GIVEN** the runtime at commit `f8f773c` with a running job `<job-id>` in state
- **WHEN** a caller invokes `node gemini-companion.mjs cancel --json <job-id>`
- **THEN** the JSON output's top-level keys are exactly `{jobId, status, title, turnInterruptAttempted, turnInterrupted}` with `status: "cancelled"` (sourced from `handleCancel` in `gemini-companion.mjs:616-622`); no `schemaVersion`, no `ok`, no `previousStatus` key

### Requirement: Hook Contract

The plugin SHALL register three hooks at the runtime-behavior level: `SessionStart`, `SessionEnd`, and `Stop`. (The static registration declaration in `hooks/hooks.json` is captured separately by the **Hook Registration** requirement; the two requirements MUST be considered together when modifying hook behavior or shape.) `SessionStart` runs `session-lifecycle-hook.mjs` and exports `GEMINI_COMPANION_SESSION_ID` plus `CLAUDE_PLUGIN_DATA` into the host session via `CLAUDE_ENV_FILE`. `SessionEnd` tears down the broker. `Stop` runs `stop-review-gate-hook.mjs` and emits a `{decision, reason}` JSON payload to stdout when the review gate is enabled and the gate fires; the `decision` is `"block"` on fail-CLOSED, and the hook exits silently (no JSON) on fail-OPEN. Hook input shape for `Stop` is `{cwd, stopHookInput.claudeResponse}` (or legacy `claude_response`).

#### Scenario: SessionStart writes session id to CLAUDE_ENV_FILE

- **GIVEN** Claude Code launches the plugin with `CLAUDE_ENV_FILE=/tmp/session.env`
- **WHEN** `session-lifecycle-hook.mjs` runs at session start
- **THEN** the file at `CLAUDE_ENV_FILE` is appended with `export GEMINI_COMPANION_SESSION_ID=...` (verifiable at `session-lifecycle-hook.mjs:44-47`)

#### Scenario: Stop hook fails CLOSED with non-zero gemini exit

- **GIVEN** `stopReviewGate: true` is set in `state.json` and `gemini -p ...` exits non-zero with stderr
- **WHEN** the `Stop` hook runs `runStopReview()` (`stop-review-gate-hook.mjs:50`)
- **THEN** the hook emits `{"decision":"block","reason":"Gemini review failed: ..."}` to stdout (round-1 swarm review fail-CLOSED semantic)

#### Scenario: Stop hook fails OPEN on ENOENT

- **GIVEN** `stopReviewGate: true` is set and the `gemini` binary is not on `PATH`
- **WHEN** the `Stop` hook attempts to spawn `gemini` (`stop-review-gate-hook.mjs:64`) and the spawn returns `error.code === "ENOENT"`
- **THEN** `runStopReview()` returns `{ok: true, reason: "Stop-review skipped: ..."}` _internally_ (`stop-review-gate-hook.mjs:83-88`); `main()` does NOT call `emitDecision()`; stdout receives zero bytes; the skip reason is surfaced on stderr via `logNote()`

### Requirement: State Layout

The plugin SHALL persist job state under a workspace-scoped directory tree rooted at `<stateRoot>/<slug>-<hash>/`. The `<stateRoot>` is `$CLAUDE_PLUGIN_DATA/state` when host detection resolves to Claude shape; otherwise `$TMPDIR/gemini-companion`. Within that directory the layout is `state.json` (top-level config and job index), `jobs/<job-id>.json` (full job record), `jobs/<job-id>.log` (timestamped progress log), and `broker-session.json` (broker liveness metadata). The `state.json` schema is `{version: 1, config: {stopReviewGate: boolean}, jobs: []}` with the integer literal `1` as the schema version. The `state.json` `jobs` array is capped at `MAX_JOBS = 50` (`lib/state.mjs:32`). On every write, `pruneJobs` (`lib/state.mjs:133-137`) sorts the array by `updatedAt` descending and slices the first 50 entries — i.e., entries with the oldest `updatedAt` are evicted (LRU-by-`updatedAt`). Entries with missing `updatedAt` sort last and are evicted first. The `broker-session.json` schema is `{endpoint: string, pidFile: string, logFile: string, sessionDir: string, pid: number | null}` (typed at `lib/broker-lifecycle.mjs:75` and persisted via `saveBrokerSession` at `lib/broker-lifecycle.mjs:86`).

#### Scenario: State paths under Claude host shape

- **GIVEN** `CLAUDE_PLUGIN_DATA=/path/to/data` and `CLAUDE_ENV_FILE` points at an existing file
- **WHEN** `resolveStateDir(cwd)` is called for a workspace at `/repo/foo`
- **THEN** the returned path is `/path/to/data/state/foo-<sha256-12hex>/` (`state.mjs:70-86`)

#### Scenario: State paths under Codex host shape

- **GIVEN** neither `CLAUDE_PLUGIN_DATA` nor `CLAUDE_ENV_FILE` is set
- **WHEN** `resolveStateDir(cwd)` is called for a workspace at `/repo/foo`
- **THEN** the returned path is `os.tmpdir()/gemini-companion/foo-<sha256-12hex>/` (`state.mjs:28,78`)

#### Scenario: broker-session.json carries the five-field schema

- **GIVEN** a freshly-spawned broker for a workspace at `/repo/foo` writes `broker-session.json` via `saveBrokerSession`
- **WHEN** a reader parses the file
- **THEN** the parsed object has exactly the keys `{endpoint, pidFile, logFile, sessionDir, pid}` with types `{string, string, string, string, number | null}`; `loadBrokerSession` (`lib/broker-lifecycle.mjs:77-84`) returns this shape verbatim or `null` if the file is missing/unparseable

### Requirement: Host Detection Contract

The plugin SHALL detect the Claude Code host shape only when `CLAUDE_ENV_FILE` is set AND points at a real, existing file. Setting only `CLAUDE_PLUGIN_DATA` MUST NOT trigger Claude shape — this defends against a stray shell-rc export of `CLAUDE_PLUGIN_DATA` from accidentally pulling Codex jobs into Claude's state tree. When neither condition holds, the runtime resolves to Codex (fallback) shape.

#### Scenario: CLAUDE_PLUGIN_DATA alone does not trigger Claude shape

- **GIVEN** `CLAUDE_PLUGIN_DATA=/some/path` is set but `CLAUDE_ENV_FILE` is unset
- **WHEN** `isClaudeHost()` is called (`state.mjs:56`)
- **THEN** the function returns `false` and the state root falls through to the Codex `os.tmpdir()/gemini-companion` path

#### Scenario: CLAUDE_ENV_FILE pointing at a missing path does not trigger Claude shape

- **GIVEN** `CLAUDE_ENV_FILE=/nonexistent/path` and `CLAUDE_PLUGIN_DATA=/some/path`
- **WHEN** `isClaudeHost()` calls `fs.statSync(envFile)`
- **THEN** the call throws and the function returns `false` (`state.mjs:61-67`)

### Requirement: Environment Variable Contract

The plugin SHALL read four environment variables as part of its public contract: `CLAUDE_PLUGIN_DATA` (Claude-shape state root), `CLAUDE_ENV_FILE` (host-detection signal AND target file for `SessionStart` env injection), `GEMINI_COMPANION_SESSION_ID` (job-record session scoping; written to `CLAUDE_ENV_FILE` by `SessionStart`), and `CLAUDE_PROJECT_DIR` (workspace cwd hint). Other env vars (e.g., `GEMINI_API_KEY`, `MOCK_AUTH`) are read by the underlying CLI subprocess, not the plugin itself.

#### Scenario: GEMINI_COMPANION_SESSION_ID scopes job records

- **GIVEN** the env var `GEMINI_COMPANION_SESSION_ID=abc-123` is set
- **WHEN** a tracked job is created via `createTrackedJob(...)` (`tracked-jobs.mjs:86`)
- **THEN** the persisted job record has `sessionId: "abc-123"` (`tracked-jobs.mjs:94`)

### Requirement: ACP Wire Identity

The plugin SHALL identify itself to `gemini --acp` with `clientInfo.name = "gemini"` (lowercase, no namespace prefix) at commit `f8f773c`. The wire identity is sourced from the `name` field of the plugin manifest (`.codex-plugin/plugin.json` first, falling back to `.claude-plugin/plugin.json`) via `getPluginInfo()` in `lib/plugin-info.mjs:31-54`. The wire identity MUST NOT be confused with the npm package name `"gemini-plugin-cc"` — `package.json` is deliberately excluded from the manifest fallback chain to prevent silent identity corruption (`lib/plugin-info.mjs:18-26` documents this exclusion). If both manifest files are absent or malformed, the loader returns the sentinel `"gemini-plugin-unknown"` rather than guessing.

#### Scenario: Broker handshake clientInfo.name is sourced from manifest

- **GIVEN** the plugin's manifest files at commit `f8f773c` declare `name: "gemini"`
- **WHEN** `acp-broker.mjs` initializes the JSON-RPC handshake (`acp-broker.mjs:138-145`) and constructs `BROKER_INFO` via `getPluginInfo()`
- **THEN** `params.clientInfo.name` in the `initialize` request is the literal string `"gemini"` derived from the manifest, not the npm package name `"gemini-plugin-cc"`

#### Scenario: Sentinel identity surfaces a broken install

- **GIVEN** a corrupted install where both `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` are missing or unparseable
- **WHEN** `getPluginInfo()` falls through to the last-resort sentinel (`lib/plugin-info.mjs:49-53`)
- **THEN** the returned identity is `{name: "gemini-plugin-unknown", version: "0.0.0"}` — chosen so it MUST NOT match any real plugin identity in consumer match logic

### Requirement: Stdio Discipline

The runtime SHALL maintain a strict stdout/stderr discipline at commit `f8f773c`. The disciplines differ per component because each has a distinct stdout consumer:

- **Companion CLI (`gemini-companion.mjs`)**: stdout is reserved for the command's structured output — JSON when `--json` is passed, rendered markdown otherwise (via `outputCommandResult` at `lib/render.mjs:381-387`). Progress messages, error messages, and informational notices MUST go to stderr (via `process.stderr.write`).
- **Broker process (`acp-broker.mjs`)**: stdout is unused; the broker's wire is the Unix domain socket (or named pipe on Windows). Diagnostic and lifecycle messages MUST go to stderr (e.g., `[gemini --acp stderr] ...`, `ACP broker: gemini --acp initialized.`).
- **Gemini child (`gemini --acp`)**: stdout carries JSON-RPC framed messages — this is the ACP wire as defined upstream. The plugin parses the child's stdout line-by-line via `readline`.
- **Stop-review-gate hook (`stop-review-gate-hook.mjs`)**: stdout receives a JSON decision payload only when the hook fails CLOSED (via `emitDecision`). All other branches (fail-OPEN, gate disabled, ALLOW pass-through, unknown-format) MUST write zero bytes to stdout; user-facing reasons go to stderr via `logNote`.
- **Session-lifecycle hook (`session-lifecycle-hook.mjs`)**: stdout MUST receive zero bytes; the hook's effect is purely side-effecting (writing to `CLAUDE_ENV_FILE`).

Mixing JSON-RPC and human-readable text on the same stdout stream would corrupt the broker wire or break consumers that pipe `setup --json` output to `jq`. This requirement is the load-bearing invariant that makes the broker pattern work.

#### Scenario: Companion --json output is wire-clean

- **GIVEN** the runtime at commit `f8f773c`
- **WHEN** a caller invokes `node gemini-companion.mjs setup --json` and pipes stdout through `JSON.parse`
- **THEN** the parse succeeds; stdout contains a single JSON object terminated with one newline (`outputCommandResult` writes `JSON.stringify(payload, null, 2) + "\n"`); stderr may contain progress noise that does not affect parsing

#### Scenario: Stop hook writes nothing to stdout when gate is disabled

- **GIVEN** `state.json::config.stopReviewGate` is `false`
- **WHEN** `Stop` hook runs
- **THEN** `main()` returns early before reaching `emitDecision`; stdout receives zero bytes; the running-task note (if any) goes to stderr via `logNote`

### Requirement: Socket Permission Mode

The broker's Unix socket SHALL be created with mode `0o600` (owner read/write only) at commit `f8f773c`. This is enforced by setting `process.umask(0o177)` around `server.listen(socketPath)` in `lib/socket-permissions.mjs:3-10`; the umask is restored in the `finally` block. A world-readable broker socket would expose JSON-RPC traffic (including prompts and tool-use payloads) to any local user. Windows named-pipe permissioning is out of scope; this requirement applies on Unix-like platforms only.

#### Scenario: Listen umask narrows socket mode to 0o600

- **GIVEN** `lib/socket-permissions.mjs:3-10` declares `listenOnRestrictedUnixSocket(server, socketPath, onListening)` that sets `process.umask(0o177)` before `server.listen(socketPath, ...)` and restores the prior umask in `finally`
- **WHEN** the broker creates its socket via this helper on a Unix-like host
- **THEN** the resulting socket file has permission mode `0o600` (`0o666 & ~0o177 = 0o600`); no group or world bits are set; an unrelated local user cannot connect

### Requirement: ACP Method Surface

The plugin SHALL invoke exactly eight ACP JSON-RPC methods (client→server) at commit `f8f773c` — seven requests and one notification — and SHALL handle exactly two server→client notification methods. The plugin handles zero server-initiated requests at this baseline; the broker dispatcher has no branch for inbound requests, so any server frame carrying both `id` and `method` is silently dropped (the `id` is matched against `pendingRequests`, finds nothing, and falls through). Any future server-initiated method (e.g., `session/request_permission`) is a new wire-surface addition introduced by a v2 change. `add-transport-abstraction-with-gemini` extracts a generic ACP client whose surface is constrained by this enumeration.

Client-emitted requests (await response):

- `initialize` — handshake, sent by both `acp-broker.mjs:141` (broker-mediated path) and `lib/acp-client.mjs:197` (direct-fallback path).
- `authenticate` — sent by `lib/gemini.mjs:236` after `initialize`, with `{methodId}` chosen from server-advertised `authMethods`.
- `session/new` — sent by `lib/gemini.mjs:413` to start a fresh session, with `{cwd, mcpServers: []}`.
- `session/load` — sent by `lib/gemini.mjs:409` to resume a prior session by ID, with `{sessionId, cwd, mcpServers: []}`.
- `session/set_mode` — sent by `lib/gemini.mjs:427` to switch session approval mode, with `{sessionId, modeId}`.
- `session/set_model` — sent by `lib/gemini.mjs:436` to switch session model, with `{sessionId, modelId}`.
- `session/prompt` — sent by `lib/gemini.mjs:458` to send a turn, with `{sessionId, prompt: [{type: "text", text: ...}]}`.

Client-emitted notifications (fire and forget):

- `session/cancel` — sent by `lib/gemini.mjs:631` to interrupt an in-progress turn, with `{sessionId}`.

Server-emitted notifications (received and dispatched by the client):

- `session/update` — server-streamed turn updates, typed at `lib/acp-protocol.d.ts:192-198`. Variants include `agent_message_chunk`, `agent_thought_chunk`, tool-call updates, and file-change updates (typed at `lib/acp-protocol.d.ts:185-190`). All `session/prompt` output arrives via this stream; the response to `session/prompt` itself carries only metadata.
- `broker/diagnostic` — broker-emitted notification typed at `lib/acp-protocol.d.ts:200-206` carrying `{source?, message}`. Used by the broker to surface stderr/exit/error events from the spawned `gemini --acp` child to the active client. The broker is the sole legitimate emitter; a `broker/diagnostic` arriving on the child's stdout is treated as a forgery attempt (`acp-broker.mjs:206-211`).

#### Scenario: Client never emits a method outside this set

- **GIVEN** the plugin runtime at commit `f8f773c`
- **WHEN** a reader greps `client.request(` and `client.notify(` across `plugins/gemini/scripts/`
- **THEN** every distinct method-name string is one of the eight listed above; no `session/cancel` is sent as a `request` (it is exclusively a `notify`); no method outside `{initialize, authenticate, session/{new,load,set_mode,set_model,prompt,cancel}}` appears

#### Scenario: session/cancel is a notification, not a request

- **GIVEN** `lib/gemini.mjs:631` invokes `client.notify("session/cancel", {sessionId})`
- **WHEN** a reader inspects the call site
- **THEN** the method is dispatched via `notify` (no `id` field, no awaited response); changing it to `request` would be a breaking semantic change for the broker's pending-request map

#### Scenario: AcpNotification union pins received notification set

- **GIVEN** `lib/acp-protocol.d.ts:208` declares `export type AcpNotification = SessionUpdateNotification | BrokerDiagnosticNotification`
- **WHEN** a reader inspects the protocol type
- **THEN** the union has exactly two members; any third notification type would be a wire-surface addition

#### Scenario: No server-initiated requests are handled at baseline

- **GIVEN** `acp-broker.mjs:160-203` (the `handleAcpLine` dispatcher) at commit `f8f773c`
- **WHEN** a JSON-RPC frame arrives from the server with both `id` and `method` (a server-initiated request, not a response or notification)
- **THEN** the broker dispatches it through the response branch (the `id` field check at line 174); the lookup against `pendingRequests` MUST find no entry, control falls through, and the broker neither replies nor errors — server-initiated requests are silently dropped at this baseline. Adding handling for any specific server-initiated method (e.g., `session/request_permission`) is a v2 wire-surface addition.

### Requirement: Spawn Contract

The plugin SHALL spawn the `gemini` binary in exactly three forms at commit `f8f773c`. Form 1 is `gemini --acp` for the long-running JSON-RPC server (broker-mediated) — invoked by `acp-broker.mjs:91` and the direct-fallback `SpawnedAcpClient` at `acp-client.mjs:238`. Form 2 is `gemini -p <prompt> --output-format text --approval-mode plan` for the stateless `Stop` hook shortcut at `stop-review-gate-hook.mjs:64`. Form 3 is `gemini --version` for the binary-availability probe at `gemini.mjs:190`. No other CLI flags are passed in the production code paths.

#### Scenario: Broker spawns gemini --acp with no other flags

- **GIVEN** a workspace requires a fresh broker session
- **WHEN** `spawnAcpProcess(cwd)` is called (`acp-broker.mjs:90`)
- **THEN** the spawn invocation is exactly `spawn("gemini", ["--acp"], {cwd, stdio:["pipe","pipe","pipe"], env: process.env})` and no model, thinking, or approval-mode flags are appended

#### Scenario: Stop hook spawns gemini -p directly, bypassing the broker

- **GIVEN** the review gate is enabled and `runStopReview` is invoked
- **WHEN** `runCommand("gemini", ["-p", prompt, "--output-format", "text", "--approval-mode", "plan"], ...)` runs (`stop-review-gate-hook.mjs:64`)
- **THEN** the spawn does NOT route through the broker socket and produces a self-contained one-shot exit

### Requirement: Exit Codes

The companion CLI SHALL exit `0` on success and `1` on any error (argument validation, missing job, ACP failure, internal exception). Stop-hook execution is exempt from the standard convention: when the review gate fails CLOSED the hook exits `0` (not non-zero) and signals "block" via stdout JSON — this matches Claude Code's hook protocol where exit non-zero would itself terminate the host session uncontrollably.

#### Scenario: Companion exits 1 on argument validation failure

- **GIVEN** `gemini-companion.mjs:handleTask` requires either `taskText` or `--resume-last`
- **WHEN** a caller invokes `node gemini-companion.mjs task` with no positional and no `--resume-last`
- **THEN** the process writes an error to stderr and exits with code `1` (verifiable at `gemini-companion.mjs:321`)

#### Scenario: Stop hook exits 0 on fail-CLOSED

- **GIVEN** the review gate is enabled and `runStopReview` returns `{ok: false, reason}`
- **WHEN** `main()` calls `emitDecision({decision: "block", reason})` and falls through
- **THEN** the hook process exits with code `0` (the catch block at `stop-review-gate-hook.mjs:172-178` similarly does not set a non-zero exit code); the block signal is conveyed entirely via stdout JSON

### Requirement: Plugin Manifest

The plugin SHALL ship two byte-identical manifest files: `.claude-plugin/plugin.json` (Claude Code host) and `.codex-plugin/plugin.json` (Codex CLI host). Each MUST declare `name: "gemini"`, `version: "1.0.1"`, a `description` field, and an `author.name` field at commit `f8f773c`. Byte-identity between the two files is the dual-host install contract — divergence breaks one host's loader.

#### Scenario: Both manifests are byte-identical

- **GIVEN** the plugin checked out at commit `f8f773c`
- **WHEN** a reader compares `plugins/gemini/.claude-plugin/plugin.json` with `plugins/gemini/.codex-plugin/plugin.json`
- **THEN** the byte-level file contents are identical (assert via SHA-256 equality or byte-by-byte diff); equivalently, `JSON.parse(claudeJson)` and `JSON.parse(codexJson)` are deep-equal; both have `name: "gemini"`, `version: "1.0.1"`, identical `description`, and identical `author.name`

### Requirement: Hook Registration

The plugin SHALL register exactly three hooks via `plugins/gemini/hooks/hooks.json` (the static manifest counterpart of the runtime-behavior **Hook Contract** requirement; both MUST be modified together for any hook change). SessionStart and SessionEnd MUST invoke `session-lifecycle-hook.mjs` with the hook name (`"SessionStart"` or `"SessionEnd"`) as a single positional argument at `argv[2]` and a 5-second timeout. The hook script dispatches on `argv[2]` via a `switch` block (`session-lifecycle-hook.mjs:139-144`); an invocation with any other or missing positional MUST be a no-op (no env injection, no broker teardown). Stop MUST invoke `stop-review-gate-hook.mjs` with a 900-second (15-minute) timeout and no positional arguments. The 15-minute Stop timeout is a deliberate choice — review tasks may take several minutes; a shorter timeout would cause spurious gate failures.

#### Scenario: hooks.json declares three hooks with specified timeouts

- **GIVEN** `plugins/gemini/hooks/hooks.json` at commit `f8f773c`
- **WHEN** a reader parses the file
- **THEN** the `hooks` map contains exactly the keys `SessionStart`, `SessionEnd`, `Stop`; the `SessionStart` and `SessionEnd` hooks each have `timeout: 5`; the `Stop` hook has `timeout: 900`; the `SessionStart` and `SessionEnd` commands invoke `session-lifecycle-hook.mjs` with the hook name as a positional argument; the `Stop` command invokes `stop-review-gate-hook.mjs`

#### Scenario: Lifecycle hook dispatches on argv[2]

- **GIVEN** `session-lifecycle-hook.mjs:139-144` declares `switch (argv[2]) { case "SessionStart": ...; case "SessionEnd": ...; }`
- **WHEN** the host launches the hook as `node session-lifecycle-hook.mjs SessionStart`
- **THEN** `argv[2]` is `"SessionStart"`, the SessionStart branch fires, and `handleSessionStart(input)` is invoked. Any positional other than `"SessionStart"` or `"SessionEnd"` falls through the switch with no side effect

### Requirement: Prompts and Agents

The plugin SHALL ship two prompt templates and one subagent at commit `f8f773c`. Templates are `plugins/gemini/prompts/adversarial-review.md` and `plugins/gemini/prompts/stop-review-gate.md`, both loaded via `loadPrompt(name, variables)` which substitutes `{{KEY}}` placeholders. The subagent is `plugins/gemini/agents/gemini-rescue.md`. Changes to template content MUST be considered behavior-affecting because review verdicts depend on the template body.

#### Scenario: stop-review-gate template pins the first-line verdict contract

- **GIVEN** `plugins/gemini/prompts/stop-review-gate.md` at commit `f8f773c`
- **WHEN** a reader inspects the template body
- **THEN** the template contains a `{{CLAUDE_RESPONSE_BLOCK}}` placeholder, AND the `<compact_output_contract>` block specifies that the first line of the model's response MUST be exactly `ALLOW: <reason>` or `BLOCK: <reason>`; the verdict tokens `ALLOW:` and `BLOCK:` are the contract `lib/review-gate-verdict.mjs` parses against — changing the template's verdict tokens is a behavior-breaking change

#### Scenario: loadPrompt substitutes placeholders

- **GIVEN** the helper `loadPrompt(name, variables)` at `lib/prompts.mjs:17-26`
- **WHEN** `loadPrompt("stop-review-gate", { CLAUDE_RESPONSE_BLOCK: "<claude_response>X</claude_response>" })` is called
- **THEN** the returned string contains the substituted block and no remaining `{{CLAUDE_RESPONSE_BLOCK}}` literal

### Requirement: Output Schema

The plugin SHALL declare the structured-review output contract in `plugins/gemini/schemas/review-output.schema.json` at commit `f8f773c`. Tools that consume Gemini review output (e.g., the `/gemini:review` slash command's renderer) MUST validate against this schema. Schema-breaking changes are by definition behavior-breaking changes for consumers.

#### Scenario: Schema pins required fields and verdict enum

- **GIVEN** `plugins/gemini/schemas/review-output.schema.json` at commit `f8f773c`
- **WHEN** a reader parses the file as JSON
- **THEN** the parsed object has `$schema: "https://json-schema.org/draft/2020-12/schema"`, `type: "object"`, `additionalProperties: false`, `required: ["verdict", "summary", "findings", "next_steps"]`, and `properties.verdict.enum: ["approve", "needs-attention"]`; each item in `properties.findings.items.required` includes `severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation`

### Requirement: Captured Absences

The baseline at commit `f8f773c` MUST NOT include the following infrastructure (each is introduced by a named follow-up change). This negative-requirement set exists so v2 spec deltas have an unambiguous diff base when adding the missing pieces.

- No wire-log emission (no JSONL log of every JSON-RPC frame; `ACP_WIRE_LOG` env var is unread). Introduced by `add-testing-and-observability`.
- No OpenTelemetry instrumentation (no `lib/tracing.mjs`; `OTEL_EXPORTER_OTLP_ENDPOINT` is unread). Introduced by `add-testing-and-observability`.
- No structured logger (no `pino` import; logging is raw `process.stderr.write()`). Introduced by `add-testing-and-observability`.
- No `ACP_PLUGIN_VERSION` env var read (no `lib/feature-flags.mjs`). Introduced by `modernize-toolchain`.
- No `tsconfig.json` and no static type-check pass over `.mjs` files. Introduced by `modernize-toolchain`.
- No `pnpm-workspace.yaml`; package management is npm with a single root `package.json`. Migrated by `modernize-toolchain`.

#### Scenario: No wire log emission at baseline

- **GIVEN** the plugin runtime at commit `f8f773c`
- **WHEN** a reader greps `plugins/gemini/scripts/` for `ACP_WIRE_LOG` or `wire-log`
- **THEN** zero hits — neither token is referenced; no JSONL wire log is emitted regardless of env vars

#### Scenario: No OpenTelemetry import

- **GIVEN** the plugin runtime at commit `f8f773c`
- **WHEN** a reader greps `plugins/gemini/scripts/` for `@opentelemetry`, `OTEL_EXPORTER`, or `tracing.mjs`
- **THEN** zero hits — no OTel instrumentation exists

#### Scenario: No ACP_PLUGIN_VERSION read

- **GIVEN** the plugin runtime at commit `f8f773c`
- **WHEN** a reader greps `plugins/gemini/scripts/` for `ACP_PLUGIN_VERSION`
- **THEN** zero hits — the feature flag is unread; behavior is unconditional
