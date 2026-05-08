## Why

The `modernize-toolchain` proposal introduces an `ACP_PLUGIN_VERSION` feature flag whose semantics assert that `v1` (the flag's default) preserves the current Gemini plugin behavior, and `add-transport-abstraction-with-gemini` requires a wire-log baseline to verify that the transport refactor is behavior-invariant. Both changes assume the current behavior exists as a documented artifact — but it doesn't. Today the contract lives only in `gemini-companion.mjs` source. This change captures that contract as a freezable spec at commit `f8f773c`, so subsequent changes have a citable baseline against which behavior invariance is testable. Note: the `ACP_PLUGIN_VERSION=v1` flag value is unrelated to this capability's name (`gemini-plugin-baseline`) — they're two independent versioning axes.

## What Changes

- **NEW spec capability** `gemini-plugin-baseline` documenting the as-is contract of `gemini-plugin-cc` at commit `f8f773c`:
  - **CLI surface**: slash command set (`review`, `adversarial-review`, `rescue`, `setup`, `status`, `result`, `cancel`); internal subcommands (`task`, `task-worker`, `task-resume-candidate`); the `rescue` slash command has no companion-side parser (routes to the `gemini-rescue` subagent).
  - **Command flag taxonomy**: per-command `valueOptions` and `booleanOptions` accepted by `parseCommandInput`; e.g. `setup` accepts only `--json --enable-review-gate --disable-review-gate` (no `--cwd`); `review` and `adversarial-review` share identical schemas.
  - **Flag value domains**: enums for value-bearing flags — `--thinking` ∈ `{off,low,medium,high}`, `--scope` ∈ `{auto,working-tree,branch}`, `--approval-mode` ∈ `{default,auto_edit,yolo,plan}`, `--model` keyed against `MODEL_ALIASES`.
  - **Captured absences**: at the baseline, no wire log, no OpenTelemetry, no structured logger (pino), no `ACP_PLUGIN_VERSION` flag read, no tsconfig, no pnpm — these are introduced by named follow-up changes and pinned here as a negative diff base.
  - **Exit codes**: companion exits `0` on success, `1` on argument validation or runtime errors. The Stop hook always exits `0` and signals "block" via stdout JSON (per Claude Code hook protocol).
  - **`--json` output shapes** for `setup`, `status`, `result`, `cancel`, `task` (current flat shapes — `geminiAvailable`, `authenticated`, etc.; the rename to a nested schema with `schemaVersion: "v1"` is introduced separately by `align-gemini-plugin-cli-schema-with-codex`).
  - **Hook contracts**: `SessionStart` (input env handling, `CLAUDE_ENV_FILE` injection, `GEMINI_COMPANION_SESSION_ID` export); `SessionEnd` (broker teardown); `Stop` (input shape `{cwd, stopHookInput.claudeResponse}`, decision payload `{decision, reason}`, fail-OPEN/fail-CLOSED semantics from round-1 swarm review).
  - **State layout**: `state.json` schema (`version: 1`, `config.stopReviewGate`, `jobs[]`); `jobs/<id>.{json,log}`; `broker-session.json` with five-field shape `{endpoint, pidFile, logFile, sessionDir, pid}`; resolution paths under `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/` for Claude shape vs. `$TMPDIR/gemini-companion/` for Codex shape.
  - **Resume-last semantics**: `task --resume-last` looks up the latest task-kind job with a non-null `threadId`, seeds `sessionId`, and routes via `session/load`; falls back to a fresh `session/new` if no candidate exists.
  - **Socket permission mode**: broker Unix socket created with mode `0o600` via `umask 0o177` (`lib/socket-permissions.mjs`).
  - **Stdio discipline**: per-component stdout/stderr conventions — companion stdout is JSON or rendered text; broker stdout is unused (wire is the Unix socket); gemini child stdout is the ACP wire; stop-hook stdout fires only on fail-CLOSED; lifecycle hooks emit nothing to stdout.
  - **Host detection contract**: `CLAUDE_ENV_FILE` MUST be set AND point at a real file for Claude shape; otherwise Codex shape (defense against shell-rc `CLAUDE_PLUGIN_DATA` pollution).
  - **Env var contract**: `CLAUDE_PLUGIN_DATA`, `CLAUDE_ENV_FILE`, `GEMINI_COMPANION_SESSION_ID`, `CLAUDE_PROJECT_DIR`.
  - **ACP wire identity**: `clientInfo.name` is `"gemini"` (not `"gemini-plugin-cc"` — a regression risk noted in `plugin-info.mjs`).
  - **ACP method surface**: the eight client-emitted JSON-RPC methods the plugin invokes against `gemini --acp` — `initialize`, `authenticate`, `session/{new,load,set_mode,set_model,prompt}` (requests) and `session/cancel` (notification); plus the two server-emitted notifications it handles — `session/update` (turn-stream) and `broker/diagnostic` (broker-internal). Zero server-initiated requests handled at baseline.
  - **Spawn contract**: `gemini --acp` (broker), `gemini -p <prompt> --output-format text --approval-mode plan` (stop-review-gate stateless shortcut), `gemini --version` (binary probe).
  - **Plugin manifest**: `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` with `name: "gemini"`, `version: "1.0.1"`, dual-host parity (byte-identical content).
  - **Prompts and agents**: `prompts/{adversarial-review,stop-review-gate}.md` templates (loaded via `loadPrompt`); `agents/gemini-rescue.md` subagent.
  - **Hook registration**: `hooks/hooks.json` lists exactly three hooks (SessionStart, SessionEnd, Stop) with their command strings and timeouts (5s for lifecycle, 900s for Stop).
  - **Output schema**: `schemas/review-output.schema.json` defines the structured-review JSON contract.
- **Pinned to commit `f8f773c`** as the snapshot SHA. Future v2 spec deltas cite this baseline.
- **Documentation only** — no runtime code is touched. Tasks are spec-authoring only.

## Capabilities

- **New Capabilities**:
  - `gemini-plugin-baseline` — frozen contract for the gemini-plugin-cc plugin, sampled at commit `f8f773c`. The capability has no version qualifier in its name: it _is_ the baseline; future changes author `## MODIFIED Requirements` against it. Note that the JSON output shape captured here is the current flat shape (no `schemaVersion` field); the rename to a nested shape (with `schemaVersion: "v1"`) is the responsibility of `align-gemini-plugin-cli-schema-with-codex` and lives in a separate capability `delegate-plugin-cli-schema/v1`. That capability's "v1" is unrelated to this capability's baseline.
- **Modified Capabilities**: none. (No specs exist today; there is nothing to MODIFY.)

## Impact

- **Affected code**: none (descriptive change).
- **Affected docs**:
  - New: `openspec/changes/capture-baseline/specs/gemini-plugin-baseline/spec.md`.
  - Possible cross-references added later (post-archive) from `modernize-toolchain` and `add-transport-abstraction-with-gemini` spec deltas to `openspec/specs/gemini-plugin-baseline/spec.md`.
- **Affected APIs**: none (the spec describes existing APIs; it does not change them).
- **Affected tests**: none in this change. `add-testing-and-observability` will later create wire-log fixtures derived from the spec'd behavior.
- **Affected upstream rebase**: none (no source files touched).

## Dependencies

- None. This change is a leaf in the dependency graph.
- Unblocks: `modernize-toolchain` (its `feature-flags` spec MUST cite this baseline for `ACP_PLUGIN_VERSION=v1` semantics) and `add-transport-abstraction-with-gemini` (its equivalence-verification step T8 MUST replay against this baseline).

## Risks and Mitigations

- **[MED] The pinned commit `f8f773c` drifts from `main` during implementation.** New commits to the gemini codepath would invalidate the spec-as-of-snapshot.
  _Mitigation:_ the spec quotes the SHA explicitly. If `main` advances before this change archives, the spec stays anchored to the snapshot SHA — readers can `git checkout f8f773c` to verify any requirement against live source. If a behavior change lands between snapshot and archive, the proposal MUST be re-snapped (re-pinned) and the change re-validated.
- **[MED] Capturing as-is behavior risks blessing accidental design** — e.g., the stop-review-gate's stateless `gemini -p` shortcut is arguably inconsistent with the broker-mediated everything-else, but exists today.
  _Mitigation:_ the spec records as-is; redesign happens in named v2 changes that cite this baseline as the diff base. The spec is descriptive, not normative-going-forward.
- **[LOW] Validator-line-1-only requirement parsing** — see project context. Wrapped sentences where SHALL/MUST lands on line 2+ silently fail strict validation.
  _Mitigation:_ tasks include `openspec validate capture-baseline --strict` as a gate.

## Estimated Effort

1-2 days, one engineer. Pure spec authoring against existing source code; no debugging, no LLM-friction edge cases.

## Validation

- `openspec validate capture-baseline --strict` SHALL pass.
- Spec deltas SHALL parse cleanly; every Requirement SHALL have at least one `#### Scenario:` block; no Requirement SHALL be missing SHALL/MUST language on line 1.
- Cross-checking pass: every requirement in the spec SHALL be verifiable by reading the named source file at the pinned SHA. (E.g., a requirement asserting "broker spawns `gemini --acp`" cites `plugins/gemini/scripts/acp-broker.mjs:91`.)
