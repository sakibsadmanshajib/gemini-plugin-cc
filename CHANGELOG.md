# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Multi-plugin scaffold** (cross-pollination model). New
  `plugins/claude/` (installed in Claude Code, drives codex + gemini)
  and `plugins/codex/` (installed in Codex CLI, drives gemini + claude)
  alongside the existing legacy `plugins/gemini/`. Each plugin has
  byte-equivalent `.claude-plugin/` and `.codex-plugin/` manifests, a
  `commands/` dir with cross-driving slash commands (`/codex:prompt`,
  `/claude:prompt`, `/gemini:prompt`), and a `scripts/` dir with entry
  points calling `runStatelessTurn(BACKEND_NAMES.<OTHER>, options)`.
  12 structural tests verify manifest shape, byte-equivalence,
  plugin-slug-matches-name, and the cross-pollination invariant (no
  plugin script references its own host backend).
- **Gemini stateless runner** (`lib/runners/gemini-print.mjs` +
  `lib/translate/gemini-stream.mjs`). Spawns `gemini -p <prompt> -o
stream-json` for one-shot invocations that bypass ACP mode. The
  translator handles JSON-RPC envelope unwrap + bare-event passthrough
  - `type`-vs-`sessionUpdate` field tolerance + non-ACP kinds (e.g.
    `file_change`). Completes the cross-backend stateless trio:
    `runStatelessTurn(BACKEND_NAMES.GEMINI, ...)` no longer rejects.
    17 translator unit tests + dispatcher integration test.
- **Stateless runner dispatcher** (`lib/runners/dispatch.mjs`) —
  `runStatelessTurn(backendName, options)` routes to the matching
  runner. Switch-statement, not a registry; explicit cases for the
  three backends + actionable error for unknown names. Tests pin the
  mapping + that runner-side failures (spawn ENOENT, abort, etc.)
  bubble through the dispatcher unchanged.
- **`timeoutMs` defensive bound** on all three runners. SIGTERMs the
  child + rejects with `Error("run<X>: timed out after Nms")` when
  the timer fires. Distinct from `signal` (caller-driven); both can
  be set, whichever fires first wins. `settle()` clears the timer on
  every resolution path so happy-path runs don't keep the event loop
  alive.
- **Orphan-runner detection** (`lib/runners/orphan-check.mjs`).
  Per-process pid files at `<tmp>/<runner>-agent-<8hex>.pid` (per
  user spec) — `$ACP_RUNNER_PID_DIR` overrides; default `os.tmpdir()`.
  JSON body `{childPid, parentPid, runner, command, args, startedAt}`.
  `checkOrphanedRunners({reap, maxAgeMs})` classifies entries as stale
  (child PID gone) or orphaned (alive but parent dead OR older than
  maxAgeMs); `reap: true` SIGKILLs orphans + cleans pid files. All
  three runners register on spawn + deregister on settle.
- **Backend-name enum** (`lib/backends/names.mjs`) — frozen
  `BACKEND_NAMES` object + `BackendName` typedef + `ALL_BACKEND_NAMES`
  iterable + `isBackendName(value)` type guard. Single source of
  truth replacing scattered `"claude"`/`"codex"`/`"gemini"` string
  literals across runners, dispatcher, orphan-check.
- **Stateless runners** — `runClaudePrint` (`lib/runners/claude-print.mjs`)
  and `runCodexExec` (`lib/runners/codex-exec.mjs`). One-shot CLI
  invocations that bypass ACP mode entirely: spawn → stream → translate
  → TurnResult. `runClaudePrint` is currently the **only** runnable
  Claude path (Claude CLI lacks ACP). Both runners support `cwd`/`env`,
  per-invocation knobs (`model`, `effort`, `permissionMode`, etc.),
  AbortSignal cancellation (SIGTERM + reject), and exit-code-aware error
  rejection (`{exitCode, stderr}` shape). 20 integration tests using
  `node -e <script>` synthetic fakes (no real CLI dependency in CI).
- **Stream-json translators** — pure-function event mappers that turn
  each backend's `--json`/`stream-json` output into ACP `session/update`
  notifications. `lib/translate/codex-stream.mjs` handles `item.created`
  / `exec_command.*` / `turn.completed`; `lib/translate/claude-stream.mjs`
  handles `assistant` / `user` / `result` / `system` events with
  multi-block support. 48 unit tests pin every documented event shape
  - drift signal (null on unknown types).
- **Stream-runner helper** (`lib/translate/stream-runner.mjs`) —
  `consumeStreamJson(stdout, translator)` reads line-delimited JSON
  events from any Readable, runs them through a caller-supplied
  translator (single update, array of updates, or null), and
  accumulates a `TurnResult` (text, thoughtText, toolCalls,
  toolResults, usage, reason). Resolves on `turn_completed` or stdout
  EOF, whichever first. 9 tests with PassThrough streams.
- **Conformance suite expanded** — `runConformanceSuite` now runs
  against three concrete factory shapes: MockBackend (in-memory),
  `geminiBackend.transports.cli` (mock binary), and
  `codexBackend.transports.cli` (mock binary). Adding a new backend's
  cli factory is one line: `runConformanceSuite(name, () => factory(...))`.
- **`docs/observability.md`** — entry-point doc for the logger /
  wire-log / tracing trio. Env contracts, redaction posture, OTel
  lazy-load rationale, end-to-end env-cocktail example.
- **`docs/runners.md`** — entry-point doc for `runClaudePrint` +
  `runCodexExec`. Coverage matrix, anatomy diagram, options reference
  per runner, lifecycle table, "when to use" decision table.
- **`STATUS.md` markers** at three obsolete OpenSpec change roots
  (`add-codex-sdk-backend`, `add-claude-sdk-adapter`,
  `add-app-server-transport-and-marketplace-split`) record the
  CLI-only pivot's effect on each. `docs/agent-cli-design.md` prepended
  with a HISTORICAL banner pointing at those markers.
- **`lib/` parallel transport layer** (`acp/`, `transport/`, `backends/`,
  `middleware/`, `state/`, `test-utils/` plus root-level `logger`,
  `wire-log`, `tracing`, `feature-flags`). Adds an AcpSession contract,
  CliTransport / BrokerSocketTransport conforming to it, three backends
  (`gemini`, `codex`, `claude`) declaring modelAliases + transports +
  setupHints, six middlewares (redaction-first composer, audit, cost,
  retry, fallback, content-addressed cache), state v1→v2 field-additive
  migrator, and a `runConformanceSuite(name, factory)` executable contract.
- **Pure-function CLI argv builders** — `buildGeminiArgs`,
  `buildCodexArgs`, `buildClaudeArgs` codify each backend's
  `--help`-derived flag taxonomy with explicit validation (no silent
  fallbacks). 48 unit tests across the three pin argv emission per
  flag, mutual-exclusion rules, and required-with-print constraints.
- **`launchOptions` + `disableBroker` plumbing** through
  `runAcpPrompt`, `runAcpReview`, and `runAcpAdversarialReview`. End
  users can now reach `--yolo`, `--worktree`, `--policy`, `--sandbox`,
  `--include-directories`, etc. via the runtime entry points; the
  spawn factory honors `cwd`/`env` from outer args (cannot be
  overridden by stuffed launchOptions).
- **Subpath imports** — `package.json` `imports` map exposes
  `#lib/*`. All consumers under `plugins/`, `tests/`, and the lib
  itself import via `#lib/...` instead of deep relative paths.
- **`docs/cli-options-research.md`** — empirical reference from
  `--help` of installed `gemini`/`codex`/`claude` covering session
  passing, resume, stateless, and output-format flags.
- **Wire log** (`ACP_WIRE_LOG=/path.jsonl`) records every JSON-RPC
  frame both directions in a format directly consumable by
  `lib/test-utils/fixture-replayer.mjs`.
- **Dual-host install** (Claude Code + Codex CLI). Same plugin source tree
  installs into both `/plugin install gemini@google-gemini` (Claude Code)
  and `codex plugin marketplace add` (Codex CLI). New `.codex-plugin/plugin.json`
  (canonical Codex manifest), `.agents/plugins/marketplace.json` (Codex-shaped
  marketplace descriptor), `agents/openai.yaml` (Codex implicit-invocation
  interface), root `SKILL.md` (Codex skill discovery), `docs/INSTALL.md`
  (cross-host install recipes).
- **`tests/install.test.mjs`** — install-readiness contract tests under both
  Claude and Codex env shapes. Validates marketplace descriptors with
  per-host shape enforcement (Codex object form `{source: "local", path: …}`,
  Claude string form `"./…"`) so a host regressing to the wrong shape is
  caught before merge.
- **`tests/broker-lifecycle.test.mjs`** — coverage for `ensureBrokerSession`
  decision tree (live endpoint reuse, dead endpoint teardown, no-prior-session
  spawn). Pins the round-1 swarm fix that folded staleness check INTO
  `ensureBrokerSession` for race-free single-probe-per-decision behavior.
- **`tests/stop-review-gate.test.mjs`** — execution coverage for the
  stop-review-gate hook's failure semantics: fail-CLOSED on non-zero gemini
  exit, fail-OPEN on ENOENT, and the success-path skip-reason surfacing
  via `logNote(review.reason)` for unknown-format Gemini output.
- **`tests/mocks/gemini-mock.mjs`** — Zed Industries-style ACP mock binary
  for hermetic CI runs. Real executable speaking JSON-RPC over stdio,
  shadows `gemini` on PATH so `getGeminiAuthStatus` doesn't hang on the
  real `@google/gemini-cli`'s OAuth probe in environments without network
  reach to Google's auth endpoints.
- **`plugins/gemini/scripts/lib/review-gate-verdict.mjs`** — single source
  of truth for the `ALLOW:` / `BLOCK:` wire-contract tokens between
  Gemini's response and the parser. Frozen `VERDICT` const, JSDoc-typed
  `parseVerdict` pure function. The prompt template at
  `plugins/gemini/prompts/stop-review-gate.md` remains the source of truth
  for what Gemini emits; this module is the source of truth for how the
  parser interprets it.

### Changed

- **CLI-only architecture** — backends launch their CLI binary in ACP
  mode (`gemini --acp` / `codex acp`); SDK and HTTP/SSE transports
  were retired. Three `STATUS.md` markers under `openspec/changes/`
  flag the now-obsolete proposals (`add-codex-sdk-backend`,
  `add-claude-sdk-adapter`) and the partially-obsolete
  `add-app-server-transport-and-marketplace-split`.
- **Legacy `plugins/gemini/scripts/lib/acp-client.mjs` removed**
  (~454 LOC). All ACP call sites in `plugins/gemini/scripts/lib/gemini.mjs`
  now use the v2 transport layer with broker fallback semantics
  preserved (`connectGeminiAcpV2` helper). Constants
  (`BROKER_BUSY_RPC_CODE`, `BROKER_ENDPOINT_ENV`, `ACP_MAX_LINE_BUFFER`)
  moved to `plugins/gemini/scripts/lib/broker-constants.mjs`.
- **`docs/architecture.md` rewritten** for the post-pivot reality —
  removed legacy/v2 split diagram, added Middleware layer, documented
  `worker_missing` reject semantics + redaction-first invariant +
  subpath imports + no-silent-fallbacks posture.
- **`docs/backends/{gemini,codex,claude}.md` rewritten** for the
  CLI-only world. New `docs/backends/gemini.md` (was missing); codex
  and claude docs no longer advertise SDK transports.
- **Stop-review-gate hook** (`plugins/gemini/scripts/stop-review-gate-hook.mjs`)
  fails CLOSED on any non-ENOENT gemini failure (non-zero exit, signal kill,
  OOM). Was: fail-OPEN on every error. ENOENT (binary not on hook's
  inherited PATH) keeps fail-OPEN to avoid locking the user into review-
  failed loops on Finder-launched GUI apps. The success-path `review.reason`
  (skip / format-mismatch) is now logged via `logNote()` so the user sees
  WHY the gate was skipped; previously dropped silently. (Resolves Copilot
  inline comments `3171646271` and `3171646302` on artagon PR #1.)
- **`plugins/gemini/scripts/lib/plugin-info.mjs`** removes `package.json`
  from the manifest fallback chain. The `package.json.name` (`gemini-plugin-cc`,
  npm package name) drifted from the plugin manifests' `name` (`gemini`),
  silently changing ACP `clientInfo.name` and `serverInfo.name` for any
  consumer matching on identity.
- **Host detection** uses `CLAUDE_ENV_FILE` (Claude Code's session-hook
  signal) with `statSync().isFile()` validation, rather than just
  `CLAUDE_PLUGIN_DATA`. Prevents a user-exported `CLAUDE_PLUGIN_DATA`
  in shell rc from pulling Codex into Claude's state tree.
- **`.github/workflows/install.yml`** matrix is Linux-only
  (`ubuntu-latest × node-{20,22}`). Was: `{ubuntu, macos} × node-{20,22}`.
  GitHub-hosted macOS runners bill at ~10× Linux per-minute; Linux runs
  catch the vast majority of platform regressions and macOS-specific
  behaviors are unit-tested via `os.tmpdir()` + `node:path` already.

### Fixed

- **AcpClient hangs on spawn failure** — when transport health
  transitions to `worker_missing` (child died, ENOENT, etc.),
  pending requests now reject with a clear error instead of waiting
  for the caller's timeout. Caught by the `getGeminiAuthStatus`
  spawn-failure test which timed out at 30s before the fix.
- **`agents/openai.yaml:12`** — stale `.codex/INSTALL.md` reference
  replaced with `docs/INSTALL.md`. (Resolves Copilot inline comment
  `3171646292` on artagon PR #1.)
- **`tests/install.test.mjs`** — marketplace test now validates BOTH
  `.agents/plugins/marketplace.json` (Codex) AND
  `.claude-plugin/marketplace.json` (Claude) with per-host shape enforcement
  - cross-host name agreement. (Resolves Copilot inline comment
    `3171646282` on artagon PR #1.)
- **`broker-lifecycle.mjs:reapStaleBroker`** marked `@deprecated` —
  no longer called from runtime as of round-1 fix-batch which folded
  staleness + liveness into `ensureBrokerSession` for race-free single-
  probe behavior. Retained for `broker-reaper.test.mjs` compatibility;
  slated for removal in a follow-up cleanup PR.

## [1.0.1] - 2026-04-18

### Added

- **Streamed ACP output and thought chunks** ([#20], closes [#15]). `runAcpPrompt` now distinguishes `agent_thought_chunk` from `agent_message_chunk` end-to-end, accumulates a separate `thoughtText` return field, and records a dedicated `model_thought_chunk` event (char counts only — raw prose is never persisted).
- **`--stream-output` flag** for `/gemini:rescue` and `/gemini:review` ([#20]). Live stderr forwarding of model chunks and thoughts (with a `thought:` prefix). Default mode shows compact progress markers (`[session]`, `[tool]`, `.` per chunk, `[thinking]`, `[file]`, `[done] stats`). EPIPE-safe; auto-suppressed in `--json` mode unless explicitly opted in.
- **`--thinking <off|low|medium|high>` flag** ([#20]). T-shirt-sized reasoning budgets that resolve per model family (Gemini 3 / 3.1 `thinkingLevel`; Gemini 2.5 `thinkingBudget` with off→low clamping). Replaces the non-functional `--thinking-budget <n>`. Emits a one-shot stderr warning noting that upstream Gemini CLI 0.38.x delivers thinking via persistent `settings.json`, not per-invocation.
- **Gemini job observability** ([#16], closes [#14]). New `lib/job-observability.mjs` helper with bounded event log (50 events/job, 500-char diagnostic cap, ANSI/CSI/OSC/DCS stripping). Derived health fields expose liveness, progress, rate-limit, auth-block, broker, and worker states.
- **`/gemini:status` event tail** ([#16], [#20]). `renderSingleJobStatus` shows the last 5 sanitized events with human-readable `Ns ago` timestamps, rollup counters (`chunks/thoughts/tools/files`), and graceful fallback when the event log is absent.
- **Broker trust boundary** ([#16]). Distinct `broker/diagnostic` JSON-RPC method prevents compromised children from forging broker notifications.
- **CI test workflow** ([#9]). `.github/workflows/test.yml` runs `npm test` on every PR. PR cleanup workflow added.
- **Docs-agreement test suite** ([#20]). `tests/docs-agreement.test.mjs` asserts `--thinking` and `--stream-output` stay documented across `README.md`, `rescue.md`, and `review.md`, and that the stale `--thinking-budget <number>` form is gone.

### Changed

- **Model mapping and selection guidance** ([#8], closes [#7]). Updated default model aliases and selection guidance in `/gemini:rescue` and `/gemini:review` for clearer routing between Pro, Flash, and Flash-Lite.
- **ACP protocol type definitions** ([#20]). `lib/acp-protocol.d.ts` replaces the stale `AcpNotification` union (`progress`/`toolCall`/`fileChange`/`error` — none matched the real runtime) with `SessionUpdateNotification` modeling `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `file_change`, plus `broker/diagnostic`.
- **Documentation**. `README.md` adds a "Live Progress & Thinking Levels" section; `plugins/gemini/commands/rescue.md`, `plugins/gemini/commands/review.md`, and `plugins/gemini/agents/gemini-rescue.md` refreshed with new `argument-hint` and runtime-flag lists.

### Fixed

- **Root workspace path containment** ([#13], closes [#6]). Path containment check no longer false-negatives at filesystem root (`/`).
- **ACP broker socket permissions (TOCTOU)** ([#12], closes [#5]). Socket permissions now set atomically to eliminate the time-of-check-to-time-of-use race.
- **ACP protocol type map** ([#10], closes [#3]). Aligned the type definitions with the runtime method name that was actually being dispatched.
- **`--scope` flag validation** ([#9], closes [#2]). Invalid values now fail fast with a clear error instead of silently falling back to `working-tree`.
- **PID-reuse false positives** ([#16]). `defaultIsProcessAlive` now treats `EPERM` as a dead worker to avoid reading a stranger process as alive after a PID is recycled.

### Removed

- **Dead code in `stop-review-gate-hook`** ([#11], closes [#4]). Unused imports and branches pruned.
- **`--thinking-budget <number>` flag** ([#20]). Replaced by `--thinking <off|low|medium|high>`; the numeric form was non-functional.

### Security

- **Broker passthrough forgery (HIGH)** ([#16]). Broker no longer forwards arbitrary child notifications as broker-origin diagnostics.
- **Diagnostic sanitization** ([#16]). All broker and worker diagnostics strip ANSI/CSI/OSC/DCS sequences and enforce a 500-char cap before entering the event log or the compact job index.
- **Privacy-preserving observability** ([#16], [#20]). Compact job-index and progress events use an explicit allow-list. Raw prompts, raw model prose, and raw thought prose never enter job files, status output, or logs — only char counts.

### Stats

- 51 files changed, +4547 / -263 lines across 8 merged PRs.
- Test suite: 172 / 172 passing.

[1.0.1]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/compare/v1.0.0...v1.0.1
[#20]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/20
[#16]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/16
[#15]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/15
[#14]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/14
[#13]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/13
[#12]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/12
[#11]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/11
[#10]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/10
[#9]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/9
[#8]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/pull/8
[#7]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/7
[#6]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/6
[#5]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/5
[#4]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/4
[#3]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/3
[#2]: https://github.com/sakibsadmanshajib/gemini-plugin-cc/issues/2
