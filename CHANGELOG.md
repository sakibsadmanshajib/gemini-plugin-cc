# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
- **`agents/openai.yaml:12`** — stale `.codex/INSTALL.md` reference
  replaced with `docs/INSTALL.md`. (Resolves Copilot inline comment
  `3171646292` on artagon PR #1.)
- **`tests/install.test.mjs`** — marketplace test now validates BOTH
  `.agents/plugins/marketplace.json` (Codex) AND
  `.claude-plugin/marketplace.json` (Claude) with per-host shape enforcement
  + cross-host name agreement. (Resolves Copilot inline comment
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
