# Design: modernize-toolchain

## Context

This is the foundational change. Decisions made here ripple through every
subsequent change. The principle is: pick tools that are correct for the
end state (multi-package monorepo, multiple backends, observability
required), not the current state (single-package npm-based plugin).

## Decisions

### D1: pnpm over npm/yarn/bun

**Decision**: pnpm.

**Alternatives considered**:
- **npm**: works at small scale, but workspace strictness is weak; phantom
  deps slip through; lockfile is verbose and merge-conflict-prone.
- **yarn (Berry)**: PnP mode breaks too many tools (TypeScript pre-PnP-plugin,
  some bundlers); non-PnP mode is just a slower pnpm with worse ergonomics.
- **bun**: install speed unmatched but workspace + peer-dep edge cases
  affect plugins specifically. The plugin uses `peerDependencies: "*"` for
  shared `pi-ai`-style libraries; bun's resolver has known issues with
  this pattern. Reassess at Stage 2 boundary.

**Rationale**: pnpm's strict resolution catches bugs at type-check time
that npm hides until runtime. Workspace protocol (`workspace:*`) maps
cleanly to the multi-package layout we'll have at Stage 2. `pnpm-lock.yaml`
is human-readable and merge-friendly.

### D2: tsgo + JSDoc over full TypeScript

**Decision**: JSDoc with type-checking via tsgo (`@typescript/native-preview`).

**Alternatives considered**:
- **Full TypeScript with build step**: typed source, build-to-dist, ship
  `.mjs` from `dist/`. Cost: contributors and users debug compiled code,
  not source. Plugin distribution is "users read your source"; obscuring
  source is anti-feature here.
- **Plain JavaScript, no types**: lowest setup cost, but JSON-RPC protocol
  code without types accumulates marshaling bugs over time. Disqualified.
- **TypeScript via Node 22 strip-types**: experimental, version-pinned,
  not yet stable enough for a 22-week project. Reassess at Stage 2.

**Rationale**: JSDoc gives full type-checking with zero build step.
Contributors and users read the same file that runs. tsgo is fast enough
that type-checking is unobtrusive. The trade-off — more verbose function
signatures than `.ts` syntax — is acceptable for an infrastructure-level
plugin.

**Risk**: tsgo is pre-1.0. Mitigation: weekly cron job runs typecheck
under stable tsc; if tsgo regresses, fall back without changing source.

### D3: Biome over ESLint + Prettier

**Decision**: Biome.

**Alternatives**:
- **ESLint + Prettier**: standard, plugin ecosystem rich. Cost: two tools,
  two configs, slow on large codebases, frequent version-conflict issues.
- **oxlint**: faster than Biome on lint, but no formatter. Would still
  need Prettier or Biome for formatting. Two-tool problem returns.
- **dprint**: pluggable formatter, but adoption smaller; less momentum.

**Rationale**: one config, one binary, faster, fewer surprises. The lint
rule set is smaller than ESLint's at extreme edges, but the project's
needs (no `console.log`, import sort, basic correctness) are well-covered.

### D4: husky over lefthook

**Decision**: husky 9.

**Alternatives**:
- **lefthook**: faster startup (~30ms), Go binary. Cost: extra binary
  download, less familiar to Node-native contributors.
- **simple-git-hooks**: minimal, no install step. Cost: less flexible
  for cross-platform shell quoting.

**Rationale**: husky is the default contributors expect. The startup-time
advantage of lefthook (~30ms) is not perceptible on commits. Earlier
analysis flagged a "husky 9 + pnpm signed commits" issue; that issue is
fixed in 9.1+. No remaining reason to prefer lefthook.

If commit-time slowness becomes a real complaint during Stage 1,
reassess.

### D5: No Turborepo in Stage 1

**Decision**: skip Turbo for now.

**Rationale**: Turbo's value is task orchestration across packages with
caching. With one package, both are minimal. Adding Turbo now means
maintaining a config that does little. Stage 2 introduces multiple
packages — that's the right time. Use plain pnpm scripts in the
meantime.

### D6: Workspace globs added incrementally

**Decision**: do not pre-declare empty workspace globs.

**Alternatives**:
- **Pre-declare `lib/*` and `plugins/*`**: ready for Stage 2 without
  changes. Cost: pnpm warns about empty globs on some platforms; Turbo
  (when added) can cache-invalidate against non-existent paths.

**Rationale**: each glob is added in the change that introduces the
first package matching it. Avoids platform warnings and ensures the spec
declaration stays honest.

### D7: ACP_PLUGIN_VERSION as runtime flag

**Decision**: environment variable, not build flag.

**Rationale**: trunk-based development requires v1 and v2 behavior to
coexist on disk. Build flags would require parallel artifacts. Runtime
flag means one binary path, both behaviors. The cost — runtime branches
— is acceptable for a long-lived plugin where reverting is more
important than minor performance.

## Open Questions

1. **What's the exact tsgo version pin policy?** Pin to caret (`^`) and
   accept minors, or pin to exact and bump deliberately? Recommendation:
   exact pin; tsgo's pre-1.0 status means minor bumps can be breaking.

2. **Should the `prepare` script be opt-out for CI?** husky's default
   `prepare` script installs hooks on every install, including in CI
   where they're useless. Mitigation: `HUSKY=0 pnpm install` in CI.
   Document in CI workflow.

3. **What about Windows?** The repo notes Windows is untested. New
   tooling (Biome, tsgo, pnpm, husky) all support Windows but the
   acceptance criteria don't gate on Windows. Position: Windows is
   "not regressed" — if it worked before, it should still work, but
   no new claims.

## v1 Baseline

The runtime behavior referenced by `ACP_PLUGIN_VERSION=v1` is the
behavior of the plugin at the last commit on `main` before this
change's first PR merges. The exact SHA SHALL be recorded here at
implementation time:

```
v1-baseline-sha: <SHA-TO-BE-RECORDED-AT-IMPLEMENTATION>
```

Behaviors defining the v1 baseline (high-level):
- single Claude Code plugin shell named `gemini`
- slash commands: `/gemini:review`, `/gemini:adversarial-review`,
  `/gemini:rescue`, `/gemini:status`, `/gemini:result`,
  `/gemini:cancel`, `/gemini:setup`
- subprocess-based `gemini --acp` invocation via direct (non-abstracted)
  ACP broker code
- job state files under `~/.local/share/acp-plugins/<job-id>/` (or
  platform equivalent), no `schemaVersion` field
- logs to stderr via `console.log`/`console.error`, no structured
  format

When subsequent changes need to amend this baseline (e.g., a critical
bug fix that must apply to both v1 and v2), the affecting change's
proposal SHALL document the amendment under a "v1 baseline amendment"
section, and the table of amendments below SHALL be updated.

### v1 baseline amendments

| Date | Change ID | Amendment |
|------|-----------|-----------|
| —    | —         | (none yet) |
