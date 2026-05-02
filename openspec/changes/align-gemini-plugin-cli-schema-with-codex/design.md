## Context

Two delegation plugins on this stack — `codex-plugin-cc` (upstream OpenAI) and `gemini-plugin-cc` (forked at `feat/dual-host-codex`) — expose the same seven slash commands but differ in three layers: `--json` output shape, CLI flag taxonomy, and prompt-body structure. The proposal scopes a unidirectional alignment: Gemini conforms to a frozen v1 baseline of Codex's behavior. This design document covers the implementation choices, rejected alternatives, and risks.

**Current state (verified live on the user's machine):**
- Codex `setup --json` returns nested `{ready, node{}, npm{}, codex{}, auth{}, sessionRuntime{}, reviewGateEnabled, actionsTaken, nextSteps}`.
- Codex `status --json` returns `{workspaceRoot, config{}, sessionRuntime{}, running[], latestFinished, recent[], needsReview}`.
- Gemini `setup --json` returns flat `{geminiAvailable, geminiVersion, authenticated, authMethod, npmAvailable, reviewGate, message}`.
- Codex `gemini-companion.mjs` had 7 commits in the last 60 days upstream; `lib/render.mjs` had 5. Upstream is shipping ~weekly to the same files this change rewrites.
- Three test assertions reference the old keys (`tests/install.test.mjs:212, 213, 228`); one Markdown table in `skills/agent-cli-doctor/references/gemini.md:14-18` documents them.

**Constraints inherited from the proposal:**
- The v1 schema is FROZEN at this change's archive date. Future Codex drift does NOT auto-update v1.
- Hard cut at the v0 → v1 boundary, signaled by a new top-level `schemaVersion: "v1"` field on every `--json` output.
- Tests, the agent-cli-doctor reference, the parity test, and the rebase-strategy decision must all land in the same change.

## Goals / Non-Goals

**Goals:**
- Gemini's `setup`, `status`, `result`, `cancel` `--json` outputs deep-structurally match Codex's at snapshot date, with `schemaVersion: "v1"` on every payload.
- CLI surface parity: Gemini accepts both `--effort` (Codex name) and `--thinking` (current Gemini name); `task` accepts prompts with or without `--`; `task-worker` and `task-resume-candidate` are hidden from `--help`; `--cwd` is documented as canonical.
- Prompt-body parity: Gemini's `review.md`, `adversarial-review.md`, and `rescue.md` mirror Codex's structure (size estimation, `AskUserQuestion` wait-vs-background flow, review-only constraint, subagent routing for rescue).
- A repo-owned `delegate-plugin-cli-schema/v1` capability documenting the frozen baseline.
- A `tests/schema-parity.test.mjs` that uses deep-recursive comparison and includes at least one behavior-parity case.
- Coordinated update of `skills/agent-cli-doctor/references/gemini.md` to the new key shape.

**Non-Goals:**
- Modifying `codex-plugin-cc`. Codex is the reference implementation as of snapshot date; this change does not assume the right or ability to change Codex.
- Live mirror of Codex's evolving schema. Post-snapshot Codex drift is a v2 decision, not an automatic propagation.
- Fixing upstream `gemini-plugin-cc` bugs unrelated to schema alignment.
- Adding a normalizer adapter on the orchestrator side (option iii from `/opsx:explore`); the user picked option (i) "mirror in plugin."
- Changing Claude Code's plugin install path or the dual-host install layout — that's the parent `feat/dual-host-codex` change's territory.

## Decisions

### D1. Snapshot the schema; do not live-mirror

**Decision:** Define v1 by capturing the EXACT current Codex JSON shape (verified at snapshot date) into the `delegate-plugin-cli-schema/v1` spec. Future Codex drift does not auto-update this spec.

**Alternatives rejected:**
- **Live mirror** (original posture): Codex is upstream OpenAI, outside our control. Every Codex drift becomes mandatory downstream Gemini work. Frame critic + Codex round-1 reviewer both flagged this as a category error.
- **Drop the capability, regression-test only** (frame critic's recommendation): cleaner, but we'd lose the durable contract and the discoverability of "what does v1 mean?" for future delegate plugins.
- **Author an abstract schema both implement** (option ii from explore): asks us to spec software we don't own.

**Why snapshot wins:** Discoverability + frozen scope. The capability says "v1 was THIS shape on THIS date"; future delegate plugins implement v1 verbatim. If Codex drifts, that's a v2 conversation.

### D2. `schemaVersion` as the migration mechanism

**Decision:** Every `--json` output gains a top-level `schemaVersion: "v1"` string field. Consumers that want stability pin to v1; consumers that don't pin are responsible for handling future versions. No in-flight aliasing window between v0 and v1.

**Alternatives rejected:**
- **Hard cut, no version field** (original posture): Codex round-1 reviewer correctly flagged this as under-argued. Schema version fields are exactly the right tool when consumers are parsers, not humans.
- **Time-boxed dual-shape window** (e.g., emit both v0 and v1 keys for one release): silent dual-shape support invites ambiguity bugs and complicates the parity test.
- **Per-key versioning** (e.g., `gemini.v1` nested key): non-idiomatic, harder to consume.

**v0 → v1 cut points:**
- `geminiAvailable: bool` → `gemini: { available: bool, detail: string }`
- `geminiVersion: string` → folded into `gemini.detail`
- `authenticated: bool` + `authMethod: string` → `auth: { available, loggedIn, detail, source, authMethod, verified, requiresOpenaiAuth, provider }`
- `npmAvailable: bool` → `npm: { available, detail }`
- New top-level: `ready: bool`, `node: { available, detail }`, `sessionRuntime: { mode, label, detail, endpoint }`, `schemaVersion: "v1"`, `reviewGateEnabled` (renamed from `reviewGate`), `actionsTaken: []`, `nextSteps: []`.

### D3. Extract response-shaping into `lib/setup-shape.mjs` for rebase isolation

**Decision:** Don't rewrite `handleSetup`'s body to emit the new shape directly. Instead extract a thin layer:

```
plugins/gemini/scripts/lib/setup-shape.mjs    (NEW)
  buildSetupReport({ gemini, npm, node, auth, sessionRuntime, config, ... })
  → returns { schemaVersion, ready, node, npm, gemini, auth, sessionRuntime, ... }

plugins/gemini/scripts/gemini-companion.mjs:handleSetup
  → calls buildSetupReport with the same probed values it currently uses
```

**Alternatives rejected:**
- **Inline rewrite of `handleSetup`** (the obvious approach): touches the upstream-tracked file's busiest function. Upstream had 7 commits to `gemini-companion.mjs` in 60 days; every rebase risks conflicting in `handleSetup`'s body.
- **Vendor the entire output assembly** (e.g., copy Codex's `setup-shape.mjs` if it exists): we don't have an interop license; cleanest is to reimplement.
- **Soft-fork the plugin entirely** (acknowledge we own a divergent fork): proposal explicitly chose to keep upstream rebase compatibility.

**Why extraction wins:** `handleSetup` becomes a 5-line wrapper that calls `buildSetupReport`. Upstream changes to `handleSetup` are absorbed by leaving the wrapper untouched; our diff lives in a NEW file (`setup-shape.mjs`) which has zero upstream conflict surface.

Same pattern for `handleStatus`, `handleResult`, `handleCancel` → `lib/status-shape.mjs`, `lib/result-shape.mjs`, `lib/cancel-shape.mjs`.

### D4. CLI flag aliasing strategy

**Decision:**
- `--effort` becomes an alias for `--thinking` on every subcommand that accepts `--thinking`. Both work; `--effort` is the canonical (matches Codex), `--thinking` stays for source compatibility with prior Gemini callers. The parity test asserts `--help` output mentions `--effort` (canonical) but does NOT require `--thinking` to be hidden.
- `--` separator: keep optional. Gemini's parser already accepts both forms (verified at `args.mjs:26-59`); this is a documentation update, not a code change.
- `task-worker` AND `task-resume-candidate` are filtered from `--help` output but still callable (they're internal subcommands the runtime uses for IPC). The `--help` filter is in `gemini-companion.mjs`'s help-text generator.
- `--cwd` is documented in `--help` as a stable canonical flag on every subcommand that accepts it.

**Alternatives rejected:**
- **Rename `--thinking` to `--effort` outright** (no alias): breaks existing Gemini-specific callers. Aliasing is cheap and removes the breakage.
- **Remove `task-worker` from the runtime entirely**: it's the IPC entry point for spawned background workers; removing breaks the runtime.

### D5. Prompt-body port: copy Codex's structure, swap `Codex` → `Gemini` and preserve Gemini-specific flags

**Decision:** For `commands/{review,adversarial-review,rescue}.md`, port Codex's body verbatim (modulo `s/codex/gemini/g` and equivalents) AND add Gemini-specific sections for `--thinking`, `--stream-output`, the `--model` taxonomy. The `rescue.md` body becomes a thin "route to gemini-rescue subagent" wrapper, mirroring Codex's "route to codex-rescue" pattern.

**Alternatives rejected:**
- **Keep current Gemini bodies unchanged**: schema-asymmetric, defeats the change.
- **Author entirely new bodies**: re-litigates Codex's design choices for execution-mode rules; unnecessary risk.

### D6. Schema-parity test design

**Decision:** `tests/schema-parity.test.mjs` does:
1. **Subcommand parity**: runs both companions with `--help`, parses subcommand list (excluding hidden ones per D4), asserts set-equality.
2. **Flag parity per subcommand**: parses each subcommand's argument list, asserts canonical flags (`--effort`, `--cwd`, `--json`, `--wait`, `--background`, `--base`, `--scope`, etc.) are present in both. Aliases (Gemini's `--thinking`) are allowed extras.
3. **Output schema parity (deep-recursive)**: runs both `setup --json`, `status --json` (with no jobs), `result --json` (with no job-id; expects error envelope), `cancel --json` (same). Asserts deep key-set equality, recursing into nested objects. Allows scalar value differences (e.g., `auth.detail` strings differ); fails on missing or extra keys.
4. **Behavior-parity case**: runs `status --wait --timeout-ms 100` on both with no jobs; asserts both exit successfully (or both with the same error code) within the timeout window. Catches the kind of asymmetry Codex round-1 flagged.

**Alternatives rejected:**
- **Top-level keys only** (proposal's first pass): too weak. Codex round-1 correctly flagged that drift can hide inside `auth{}`, `sessionRuntime{}`, status enums.
- **Snapshot test against fixture JSON files**: brittle to Codex version bumps within v1 (e.g., `auth.detail` text changes).
- **Run both companions against a shared mock workspace**: extra infrastructure not justified for this scope.

### D7. Hooks remain unchanged

**Decision:** The current `plugins/gemini/hooks/hooks.json` (`SessionStart`, `SessionEnd`, `Stop`) stays. The earlier (since-removed) "move SessionEnd to Stop" item was based on incorrect premises; OpenAI's reference Codex plugin uses `SessionEnd` itself. Codex's hook event enum doesn't include `SessionEnd`, but that's Codex's design choice; OpenAI ships it anyway. No change needed.

## Risks / Trade-offs

- **[HIGH] Upstream rebase risk on `gemini-companion.mjs`** → Mitigated by D3: extracting response-shaping into new files (`lib/*-shape.mjs`). `handleSetup` becomes a wrapper; the wrapper's body diff is small enough that upstream changes to surrounding code rebase cleanly. Conflicts on the wrapper itself are quick to resolve manually.

- **[HIGH] Snapshot v1 freezes Codex behavior at a moment in time** → If Codex drifts and orchestrators come to depend on the new shape, our v1 looks stale. Mitigated by: `delegate-plugin-cli-schema/v2` is a future change, not an emergency. The orchestrator is hypothetical today (no real consumer breaks); we have time to react to drift if it matters.

- **[MED] `schemaVersion` field is a one-way ratchet** → Once we ship v1, dropping the field is its own breaking change. Mitigated by: this is the standard cost of versioned schemas. The benefit (deterministic consumer pinning) outweighs.

- **[MED] Prompt-body port introduces logic Gemini didn't previously have** → Codex's `review.md` does pre-flight `git status` / `git diff --shortstat` and asks `AskUserQuestion`. This is more behavior than Gemini's current bare wrapper. Could surface bugs in the size-estimation path under unusual git states. Mitigated by: Codex has been running this logic for months in production; the path is well-tested.

- **[MED] The `delegate-plugin-cli-schema/v1` spec document sits in this repo but the canonical reference is at upstream `~/.codex/plugins/marketplaces/openai-codex/`** → Future readers may not know whether to consult the spec or the live binary. Mitigated by: the spec MUST cite the snapshot commit/version of `codex-plugin-cc` it was sampled from; readers can `git checkout` that version to see live truth.

- **[LOW] `--effort` ↔ `--thinking` alias creates two ways to do the same thing** → Cognitive overhead. Mitigated by: `--help` shows only `--effort` (canonical); `--thinking` works but isn't advertised; deprecation warning emitted to stderr if `--thinking` is used.

- **[LOW] Behavior parity test (D6.4) is hand-coded, not exhaustive** → Misses divergences in exotic flag combos. Mitigated by: parity is a regression gate, not a proof; the test prevents the obvious drift, future asymmetries get caught when they bite.

## Migration Plan

**Per-plugin release:**

1. Implement D3 layer extraction in a single PR (no behavior change yet — just refactor `handleSetup`/`handleStatus`/`handleResult`/`handleCancel` to call into `lib/*-shape.mjs` that returns the *current* v0 shape). Verify all 190 tests still pass.
2. In a follow-up PR, modify each `*-shape.mjs` to emit the v1 shape with `schemaVersion: "v1"`. Update the 3 test assertions in `tests/install.test.mjs` and the 5-row table in `skills/agent-cli-doctor/references/gemini.md`.
3. Add `tests/schema-parity.test.mjs`. Run it; expect green.
4. Update the rescue-subagent (`agents/gemini-rescue.md`) to absorb the inline routing logic from `commands/rescue.md`. Then refactor `commands/rescue.md` to be a thin "route to subagent" wrapper.
5. Port `commands/{review,adversarial-review}.md` bodies. Manually test each command in both Claude Code and Codex installs.
6. Author `openspec/specs/delegate-plugin-cli-schema/spec.md` (the v1 baseline) and the change's spec deltas. Run `./bin/openspec validate align-gemini-plugin-cli-schema-with-codex --strict`. Expect green.
7. Open PR. Run 3-agent swarm review per `gh-meta-review`.

**Rollback strategy:** Each step is its own PR; revert any single PR to roll back. No data migrations, no in-flight state. The v0 → v1 cut is an output-format change only.

**Coordinated downstream updates:**
- `skills/agent-cli-doctor/references/gemini.md` updated in step 2 (same PR as the shape change). Doctor procedure changes (in `shared.md`) are NOT in scope here — they get a follow-up if the doctor's logic actually depends on the old keys.

## Open Questions

- **Should the `delegate-plugin-cli-schema/v1` spec be enforced against `codex-plugin-cc`?** I.e., should the parity test fail if Codex drifts? Pro: catches drift early. Con: we don't own Codex; failing CI on Codex changes is a maintenance burden. **Tentative answer:** the parity test runs against both companions; if Codex drifts post-snapshot, the test fails and forces an explicit decision (revert Codex install? bump to v2?). This is the desired escalation path.
- **Should `schemaVersion` be at the top level OR namespaced** (e.g., `meta.schemaVersion`)? Codex doesn't currently have it. **Tentative answer:** top-level for discoverability; consumers shouldn't have to drill in to find the version.
- **Do we need a `task --json` shape?** Codex's `task` doesn't return JSON (it streams output). Gemini's currently doesn't either. Out-of-scope for v1 unless someone pushes back.
- **Is the snapshot date the change-archive date or a separately-pinned moment?** **Tentative answer:** the date this change archives; readers see a single timestamp. The spec should also cite the `codex-plugin-cc` git commit at that moment for unambiguous reproducibility.
