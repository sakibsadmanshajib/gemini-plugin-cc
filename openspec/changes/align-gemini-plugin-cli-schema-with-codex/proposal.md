## Why

The two delegation plugins on this stack — `codex-plugin-cc` (upstream OpenAI) and `gemini-plugin-cc` (forked here on `feat/dual-host-codex`) — expose **the same seven slash commands** (`setup`, `review`, `adversarial-review`, `rescue`, `status`, `result`, `cancel`) but speak **different schemas** in three layers:

1. **`--json` output shapes.** `codex-companion.mjs setup --json` returns `{ready, node{}, npm{}, codex{}, auth{}, sessionRuntime{}}`; `gemini-companion.mjs setup --json` returns the flat `{geminiAvailable, geminiVersion, authenticated, authMethod, npmAvailable, reviewGate, message}`. Same kind of asymmetry across `status/result/cancel --json`.
2. **CLI flag taxonomy.** Codex uses `--effort`, Gemini uses `--thinking` for the same concept. Gemini's `task` requires a `--` separator before the prompt; Codex's doesn't.
3. **Prompt-body structure.** Codex's `review.md` and `adversarial-review.md` ship rich execution-mode rules (size estimation, `AskUserQuestion` wait-vs-background flow, explicit review-only constraint). Gemini's are bare runtime invocations.

This work is **preparatory cleanup**, not unblocking a concretely failing orchestrator. Today's `gh-meta-review` and `gh-workflow-review` skills don't consume `gemini-companion setup --json`; the asymmetry is theoretical/forward-looking. The motivating context is that the user just stood up a dual-host install of `gemini-plugin-cc` (`claude plugin install gemini@google-gemini` ✓, `codex plugin marketplace add` ✓, 190/190 tests green) and wants symmetry with `codex-plugin-cc` so that future orchestrators don't have to dual-parse.

## What Changes

**Schema and prompt-body alignment in `gemini-plugin-cc`:**

- **BREAKING** — Restructure `gemini-companion.mjs setup --json` output to mirror `codex-companion.mjs setup --json`:
  - `geminiAvailable: bool` → `gemini: { available: bool, detail: string }`
  - `geminiVersion: string` → folded into `gemini.detail`
  - `authenticated: bool` + `authMethod: string` → `auth: { available, loggedIn, detail, source, authMethod, verified, requiresOpenaiAuth, provider }`
  - `npmAvailable: bool` → `npm: { available, detail }`
  - Add top-level `ready: bool` (computed from `gemini.available && auth.loggedIn`)
  - Add `node: { available, detail }`
  - Add `sessionRuntime: { mode, label, detail, endpoint }` for ACP broker info
- **BREAKING** — Restructure `gemini-companion.mjs status --json`, `result --json`, `cancel --json` outputs to match Codex's per-job-record shapes (status enums, error envelopes, field names).
- **MIGRATION** — Add `schemaVersion: "v1"` as a top-level field on every `--json` output (`setup`, `status`, `result`, `cancel`). Consumers can pin to a known shape. Future shape changes bump the version with explicit migration notes; legacy callers that don't read `schemaVersion` are responsible for their own breakage. (Per Codex round-1 review: hard-cut without `schemaVersion` is under-argued.)
- Drop the `--` separator requirement on `task` (mirror Codex's positional-prompt syntax). **NOT BREAKING** — Gemini's parser already accepts both forms (`args.mjs:26-59`); making `--` optional is a compatibility expansion.
- Accept `--effort` as an alias for `--thinking` on every subcommand that already accepts `--thinking`. Keep `--thinking` working (no break).
- Hide BOTH `task-worker` AND `task-resume-candidate` from `--help`. (Per Codex round-1 review: Codex hides both internal helpers; only hiding one leaves a parity gap.)
- Document `--cwd` as a stable, supported flag on every subcommand that accepts it (both Codex and Gemini already implement it; the parity contract should explicitly include it rather than leave it as undocumented internal plumbing).
- Port Codex's `review.md` and `adversarial-review.md` command-body prompt structure into the Gemini equivalents — including the size-estimation logic, the `AskUserQuestion` wait-vs-background flow, and the explicit "review-only / do not fix" core constraint. Preserve Gemini-specific flags (`--thinking`, `--stream-output`).
- Refactor `rescue.md` to route through the existing `gemini-rescue` subagent (already at `plugins/gemini/agents/gemini-rescue.md`) the same way Codex routes through `codex-rescue`. The current inline-handling pattern in Gemini's `rescue.md` becomes the subagent's body.
- Sync minor wording in `setup.md`, `cancel.md`, `result.md`, `status.md` to mirror Codex's phrasing where it differs.
- Add `tests/schema-parity.test.mjs` that imports both companion `--help` outputs and asserts subcommand+flag agreement, AND uses **deep-recursive structural comparison** of `setup/status/result/cancel --json` outputs (not just top-level keys — drift can hide inside `auth{}`, `sessionRuntime{}`, job snapshots, status enums, error envelopes per Codex round-1 review). Test must also include at least one **behavior-parity** case (e.g., `status --wait` semantics across both companions), since flag presence isn't sufficient.

**Out-of-scope (deliberately removed from this proposal — see "Scope decisions" below):**

- ~~Move Codex skill into installed subtree~~ — round-3 SDK adversary's claim conflicts with OpenAI's own reference plugin layout; defer until verified against Codex source.
- ~~Hide internal helper skills~~ — Codex's loader source-traced (`core-skills/src/loader.rs` lines 3217-3256) reveals frontmatter parsing only consumes `name/description/metadata.short_description`; `user-invocable: false` is functionally ignored. BUT OpenAI's reference Codex plugin uses this frontmatter on three of its own skills (`codex-cli-runtime`, `codex-result-handling`, `gpt-5-4-prompting`) and keeps them inside `skills/`. So OpenAI ships skills with the ignored frontmatter rather than moving them out — defer this fix until we have empirical evidence the helpers are being incorrectly auto-invoked in practice.
- ~~Drop `.codex-plugin/marketplace.json`~~ — already dropped earlier in the parent dual-host change. Not in this scope.
- ~~Move `SessionEnd` cleanup to `Stop`~~ — `Stop` fires every turn-end, not session-end; tearing down the broker on every turn would be catastrophic. OpenAI's reference Codex plugin uses `SessionEnd` itself; the "Codex silently drops it" claim was wrong.

## Scope decisions

**(1) Snapshot Codex's v1 schema, don't live-mirror.** Per `/opsx:explore` round, the user picked option (i) "Gemini mirrors Codex." Codex round-1 adversary refined this: a *live* mirror is wrong because Codex is upstream OpenAI and outside this repo's control — every future Codex drift becomes mandatory downstream Gemini work. Refined posture: **freeze** the current Codex CLI/JSON behavior as a `v1` baseline, document it as the canonical contract for `delegate-plugin-cli-schema/v1`, and treat Codex as one compatible implementation (which it is *as of the snapshot date*). Future Codex drift becomes a *deliberate* `v2` decision, not an automatic chase. The `tests/schema-parity.test.mjs` regression test is the runtime enforcement; the proposal/specs/design artifacts are the source-of-truth for v1.

**(2) Capability is `delegate-plugin-cli-schema` scoped to a frozen v1 snapshot.** Earlier revision dropped the capability entirely (frame critic's recommendation: regression test is the contract). Codex round-1 adversary recommended the snapshot/freeze posture instead. The synthesis: **keep the capability, but freeze it.** The capability documents a v1 baseline of CLI-surface and `--json` shape that BOTH plugins must match TODAY. It does NOT say "Codex's future shape is canonical" — it says "this snapshot is canonical." If Codex drifts, our spec is unchanged; we *choose* whether to chase. The frame-critic concern about "spec'ing software we don't own" is resolved because the spec describes a frozen baseline both plugins are required to match, not a live external system.

**(3) Hard cut at v0→v1 boundary, signaled by `schemaVersion`.** Cross-file impact audit confirms: only one in-repo consumer of the old shape exists (`skills/agent-cli-doctor/references/gemini.md`, a 5-row Markdown lookup table; not code), only 3 test assertions reference the old keys (all in `tests/install.test.mjs`), no code in `gh-meta-review`, `gh-workflow-review`, or sibling `cc-gemini-plugin/scripts/gemini-bridge.js` consumes it. Dual-shape support across plugin versions invites silent bugs; the cost of a hard cut is bounded. **Migration mechanism:** every `--json` output gains a top-level `schemaVersion: "v1"` field. Consumers that pin to v1 are stable; consumers that don't pin must update to read `schemaVersion` first. The v0 → v1 cut happens once per plugin's release; no in-flight aliasing window. (Per Codex round-1 review: hard-cut + schemaVersion is more defensible than hard-cut alone.)

**(4) Defer "structural Codex install fixes" to their own change if needed.** The four absorbed round-3 findings have been re-audited and removed: two are wrong against OpenAI's reference plugin (verified live), one was already addressed in the parent change, one (`.codex-plugin/marketplace.json` removal) doesn't apply since the file no longer exists. If real install bugs surface in actual Codex runs, they get their own narrow change with code-level evidence.

## Capabilities

### New Capabilities

- `delegate-plugin-cli-schema`: A frozen v1 baseline for the CLI surface and `--json` output shape that any "delegate to a sibling LLM CLI from inside Claude Code/Codex" plugin must match. **Snapshot date:** the date this change archives. **Source of truth:** this repo's spec, NOT live upstream Codex. The spec is seeded from Codex's behavior at snapshot date (since Codex is a working reference implementation as of that date), but post-snapshot Codex drift does NOT auto-update the spec — that requires an explicit v2 change. Implementations: `codex-plugin-cc` (presumed conformant at snapshot, unverified post-snapshot) and `gemini-plugin-cc` (this fork, made conformant by this change). Future delegate plugins implement v1, v2, or whichever version they target.

### Modified Capabilities

- (none — `gemini-plugin-cc` doesn't have a tracked spec in `openspec/specs/` today.)

## Impact

**Affected code (`plugins/gemini-plugin-cc/`):**
- `plugins/gemini/scripts/gemini-companion.mjs` — `handleSetup`, `handleStatus`, `handleResult`, `handleCancel`, `handleTask`, top-level help text
- `plugins/gemini/scripts/lib/render.mjs` — `renderSetupReport` consumes the new shape; per-renderer impact verified in design (renders for `result`/`cancel` may not need to change)
- `plugins/gemini/commands/{review,adversarial-review,rescue,setup,cancel,result,status}.md` — body rewrites
- `plugins/gemini/agents/gemini-rescue.md` — gains the inline rescue logic moved from `commands/rescue.md`

**Affected tests:**
- `tests/install.test.mjs` — exactly **3 assertions** reference the old keys (lines 212, 213, 228). Self-inflicted-break risk: zero (newly-added `broker-reaper.test.mjs`, `plugin-info.test.mjs` don't touch the keyset).
- New: `tests/schema-parity.test.mjs` (subcommand+flag agreement, top-level-key agreement on `setup --json`).

**Affected docs in this repo:**
- `skills/agent-cli-doctor/references/gemini.md` lines 14–18 — 5-row Markdown lookup table mapping the old keys to natural-language descriptions. Coordinated update required as part of this change.

**Affected APIs:**
- The `--json` output of `setup`, `status`, `result`, `cancel` is a public contract. Hard cut, no aliasing — see Scope decision (3).

**Affected upstream — rebase risk:**
- `gemini-plugin-cc` is a fork of `sakibsadmanshajib/gemini-plugin-cc`. This change reshapes upstream's output contract by editing upstream-tracked files. **Upstream activity verified:** `gemini-companion.mjs` had 7 commits in the last 60 days upstream; `lib/render.mjs` had 5. Recent upstream commits include feature work (streaming output, observability, ACP protocol fixes) — not just bugfixes, structural feature additions to the same files. **Rebase risk is medium-to-high, not low.** Design phase MUST name a rebase strategy: candidates are (a) extract response-shaping into a thin `lib/setup-shape.mjs` so upstream's `handleSetup` body stays diffable, (b) accept periodic painful rebases, (c) abandon the soft-fork posture by upstreaming this work to `sakibsadmanshajib/gemini-plugin-cc` as a PR (eliminates rebase entirely if merged).
