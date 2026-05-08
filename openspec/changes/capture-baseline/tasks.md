# Tasks: capture-baseline

This change is documentation/spec authoring only. No runtime code is touched. Each task is implementable in ≤2 hours and uses static analysis only — no test execution. (Behavior verification via execution belongs in `add-testing-and-observability`.)

## 1. Snapshot pinning verification

- [x] T1.1 — Confirm `f8f773c` is the intended baseline. Verified subject matches: `f8f773c fix(openspec): rewrite stale project.md mentions in review records`.
- [x] T1.2 — Verify no behavior-affecting commits have landed on `main` since `f8f773c` that touch `plugins/gemini/scripts/**` or `plugins/gemini/hooks/**`. Verified empty diff: `rtk git diff --stat f8f773c..HEAD -- plugins/gemini/scripts plugins/gemini/hooks` returned no output. Snapshot SHA matches working tree.

## 2. Cross-check spec against source (static analysis only)

For each requirement in `specs/gemini-plugin-baseline/spec.md`, verify the cited file:line reference resolves at the pinned SHA by reading source — do not run code.

- [ ] T2.1 — CLI Surface: read `plugins/gemini/commands/` directory listing at `f8f773c` and confirm exactly seven `.md` files named in the spec.
- [ ] T2.2 — CLI Surface: read `gemini-companion.mjs` switch block at lines 730-750 and confirm it routes the three internal subcommand labels.
- [ ] T2.3 — JSON Output Shape (setup): read `handleSetup` and the helpers it calls in `gemini-companion.mjs` and confirm the emitted top-level keys are exactly the spec's claimed set. Static analysis only — no execution.
- [ ] T2.4 — JSON Output Shape (task): read `gemini-companion.mjs:397` and confirm the emitted JSON includes `rawOutput: result.text`.
- [ ] T2.5 — JSON Output Shape (status/result/cancel): read `handleStatus`, `handleResult`, `handleCancel` and confirm top-level keys match the spec scenarios for each.
- [ ] T2.6 — Hook Contract: read `plugins/gemini/hooks/hooks.json` and confirm exactly three hooks are registered: `SessionStart`, `SessionEnd`, `Stop`.
- [ ] T2.7 — Hook Contract: read `session-lifecycle-hook.mjs:44-47` and confirm it writes the `export GEMINI_COMPANION_SESSION_ID=...` line to `CLAUDE_ENV_FILE`.
- [ ] T2.8 — Hook Contract: read `stop-review-gate-hook.mjs:50` (entry point), `:64` (gemini -p spawn), `:89-94` (fail-CLOSED), `:83-88` (fail-OPEN ENOENT) and confirm the spec's claims.
- [ ] T2.9 — State Layout: read `state.mjs:70-86` and confirm Claude vs Codex path resolution matches the spec.
- [ ] T2.10 — Host Detection: read `state.mjs:56-68` (`isClaudeHost`) and confirm both conditions (`CLAUDE_ENV_FILE` set AND `fs.statSync().isFile()` true).
- [ ] T2.11 — Env Var Contract: `rtk rg -n "process\.env\." plugins/gemini/scripts/` and confirm only the four contract env vars are read by plugin code.
- [ ] T2.12 — ACP Wire Identity: trace `BROKER_INFO` through `plugin-info.mjs` and `acp-broker.mjs:142` and confirm `clientInfo.name` resolves to the literal string `"gemini"`.
- [ ] T2.13 — Spawn Contract: `rtk rg -n "spawn\(\"gemini\"|runCommand\(\"gemini\"" plugins/gemini/scripts/` and confirm exactly three production-path gemini-binary invocations matching the spec'd forms.
- [ ] T2.14 — Command Flag Taxonomy: read each handler's `parseCommandInput(argv, {valueOptions, booleanOptions})` schema (lines 172, 219, 262, 306, 501, 550, 575, 630 of `gemini-companion.mjs`) and confirm flags listed match the spec's per-command enumeration. Confirm `setup` has no `valueOptions`. Confirm `review` and `adversarial-review` schemas are identical.
- [ ] T2.15 — Plugin Manifest: byte-compare `plugins/gemini/.claude-plugin/plugin.json` and `plugins/gemini/.codex-plugin/plugin.json` (e.g., `rtk diff` or SHA-256 equality). Confirm parsed JSON deep-equality, with `name: "gemini"`, `version: "1.0.1"`, identical `description`, identical `author.name`.
- [ ] T2.16 — Hook Registration: confirm `hooks.json` `SessionStart` and `SessionEnd` each have `timeout: 5`, the `Stop` hook has `timeout: 900`, lifecycle hook commands invoke `session-lifecycle-hook.mjs` with the hook name as positional, the Stop command invokes `stop-review-gate-hook.mjs`.
- [ ] T2.17 — Prompts and Agents: confirm `plugins/gemini/prompts/{adversarial-review,stop-review-gate}.md` exist and the stop-review-gate template body contains a `{{CLAUDE_RESPONSE_BLOCK}}` placeholder AND a `<compact_output_contract>` block specifying first-line `ALLOW: <reason>` or `BLOCK: <reason>`. Confirm `loadPrompt` at `lib/prompts.mjs:17-26` substitutes `{{KEY}}` placeholders. Confirm `plugins/gemini/agents/gemini-rescue.md` exists.
- [ ] T2.18 — Output Schema: read `plugins/gemini/schemas/review-output.schema.json` and confirm it parses as JSON with `$schema: "https://json-schema.org/draft/2020-12/schema"`, `type: "object"`, `additionalProperties: false`, top-level `required: ["verdict", "summary", "findings", "next_steps"]`, `properties.verdict.enum: ["approve", "needs-attention"]`, and finding items require `severity, title, body, file, line_start, line_end, confidence, recommendation`.
- [ ] T2.19 — Exit Codes: read `gemini-companion.mjs:321` (handleTask validation exit) and `stop-review-gate-hook.mjs:172-178` (catch block). Confirm companion uses `process.exit(1)` on validation/error paths and the Stop hook never sets a non-zero exit code (block signal goes via stdout JSON).
- [ ] T2.20 — Flag Value Domains: read `lib/thinking.mjs:12` (THINKING_LEVELS), `lib/git.mjs:304` (VALID_SCOPES), `lib/acp-protocol.d.ts:69` (approvalMode union), `gemini-companion.mjs:104-120` (MODEL_ALIASES). Confirm the spec's value enumerations match each source verbatim.
- [ ] T2.22 — ACP Method Surface (client→server): `rtk rg -n 'client\.(request|notify)\("' plugins/gemini/scripts/` and confirm the distinct method names are exactly `initialize`, `authenticate`, `session/new`, `session/load`, `session/set_mode`, `session/set_model`, `session/prompt`, `session/cancel`. Confirm `session/cancel` is the sole `notify` invocation; the other seven are `request` invocations.
- [ ] T2.23 — ACP Method Surface (server→client): read `lib/acp-protocol.d.ts:185-208` and confirm `AcpNotification` is the union of exactly `SessionUpdateNotification | BrokerDiagnosticNotification`. Read `acp-broker.mjs:160-203` (`handleAcpLine`) and confirm there is no branch for server-initiated requests — only response-by-id and notification-forwarding paths exist.
- [ ] T2.24 — Resume-Last Semantics: read `lib/gemini.mjs:650-666` (`findLatestTaskThread`) and `gemini-companion.mjs:331-339` (handleTask `--resume-last` branch). Confirm the lookup filters `kind === "task"` AND `threadId != null`, sorts by `updatedAt` desc, and the no-candidate path emits "No resumable Gemini session found. Starting fresh." to stderr.
- [ ] T2.25 — broker-session.json schema: read `lib/broker-lifecycle.mjs:75` (JSDoc type) and `:86-90` (`saveBrokerSession`). Confirm the persisted shape is `{endpoint, pidFile, logFile, sessionDir, pid}` with `pid` typed as `number | null`.
- [ ] T2.26 — MAX_JOBS cap and eviction algorithm: read `lib/state.mjs:32` and confirm `const MAX_JOBS = 50`. Read `lib/state.mjs:133-137` (`pruneJobs`) and confirm the eviction is `sort by updatedAt desc, then slice(0, MAX_JOBS)`.
- [ ] T2.29 — Socket Permission Mode: read `lib/socket-permissions.mjs:3-10` and confirm `listenOnRestrictedUnixSocket` sets `process.umask(0o177)` before `server.listen` and restores the prior umask in a `finally` block.
- [ ] T2.30 — Stdio Discipline: read `lib/render.mjs:381-387` (`outputCommandResult`) and confirm `process.stdout.write` only fires for the JSON or rendered payload; confirm `acp-broker.mjs` never writes to `process.stdout` (uses Unix socket); confirm `stop-review-gate-hook.mjs:32-34` (`emitDecision`) is the sole stdout write and runs only on fail-CLOSED branches; confirm `session-lifecycle-hook.mjs` writes nothing to stdout.
- [ ] T2.27 — runtimeStatus sub-shape: read `lib/gemini.mjs:264-271` (`getSessionRuntimeStatus`) and confirm the returned object has exactly `{brokerRunning: boolean, endpoint: string | null}`.
- [ ] T2.28 — Lifecycle hook argv[2]: read `session-lifecycle-hook.mjs:139-144` and confirm the `switch (argv[2])` block has cases for exactly `"SessionStart"` and `"SessionEnd"`.
- [ ] T2.21 — Captured Absences: `rtk rg -n "ACP_WIRE_LOG|wire-log|@opentelemetry|OTEL_EXPORTER|tracing\.mjs|ACP_PLUGIN_VERSION|pino" plugins/gemini/scripts/` returns zero hits. `rtk ls tsconfig.json pnpm-workspace.yaml pnpm-lock.yaml` reports each as missing.

## 3. Spec validation

- [ ] T3.1 — Run `rtk openspec validate capture-baseline --strict` and resolve any errors. The validator checks line 1 of each requirement body for SHALL/MUST — reword any wrap-induced failures.
- [ ] T3.2 — Run `rtk openspec status --change capture-baseline` and confirm `isComplete: true` (or that all `applyRequires` artifacts are `done`).

## 4. Cross-reference setup

- [ ] T4.1 — Add a forward note to `modernize-toolchain/proposal.md` (Dependencies section) clarifying that `capture-baseline` provides the baseline its `feature-flags` spec asserts. Single-line edit.
- [ ] T4.2 — Add a forward note to `add-transport-abstraction-with-gemini/proposal.md` (Dependencies section) clarifying that the equivalence-verification step (T8) replays against the `gemini-plugin-baseline` capability. Single-line edit.

## 5. Adversarial review (project policy)

- [ ] T5.1 — Cross-model adversarial review: at least two reviewers (Codex via `/codex:rescue` or Gemini via `/gemini:rescue`) read `proposal.md` + `spec.md` and report findings. Per Stage-1 gate policy this is required before archive.
- [ ] T5.2 — Address review findings: for each blocking finding, edit `proposal.md` / `spec.md` and re-run T3.1.

## 6. Archive

- [ ] T6.1 — Run `rtk openspec validate capture-baseline --strict` one final time. MUST exit 0.
- [ ] T6.2 — Run `rtk openspec archive capture-baseline` (or invoke the `opsx:archive` skill). This moves `specs/gemini-plugin-baseline/spec.md` from the change tree into `openspec/specs/gemini-plugin-baseline/spec.md` (canonical post-archive path).
- [ ] T6.3 — Verify the canonical spec exists at `openspec/specs/gemini-plugin-baseline/spec.md` and the change directory is moved/cleaned per OpenSpec convention.

## Acceptance

- [ ] `openspec validate capture-baseline --strict` passes
- [ ] At least 2 cross-model adversarial reviews recorded
- [ ] Spec archived at `openspec/specs/gemini-plugin-baseline/spec.md`
- [ ] Forward references from `modernize-toolchain` and `add-transport-abstraction-with-gemini` proposals point to the archived capability
