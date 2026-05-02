# Modernize Toolchain

## Why

`gemini-plugin-cc` uses npm with a hand-coded build order, no type checking,
no linter, no formatter, and no test framework configured beyond a shell
script. This is the foundation for a 22-25 week multi-backend expansion.
Without modern toolchain underneath, every subsequent phase pays interest on
toolchain debt — slower iteration, missed bugs that types would catch,
contributor friction, inconsistent style.

This change establishes the toolchain that all subsequent changes assume.

## What Changes

- **BREAKING**: package manager switches from npm to pnpm. Lockfile changes
  from `package-lock.json` to `pnpm-lock.yaml`. Local install commands change.
- Workspaces enabled via `pnpm-workspace.yaml`. Initial layout has no
  workspace packages declared (single root package); globs added
  incrementally as packages are created.
- Type checking via `tsgo` (`@typescript/native-preview`) with JSDoc
  annotations. JavaScript source remains `.mjs`; no build step introduced.
- Lint and format via Biome. Single config at repo root.
- Pre-commit hook via husky (lighter setup than alternatives, sufficient
  for this project's signing model).
- `ACP_PLUGIN_VERSION` environment variable introduced. Default `v1`. All
  v2 behavior introduced in subsequent changes MUST gate on this flag.

## Impact

- **Affected specs**: introduces `toolchain`, `monorepo-shape`,
  `feature-flags`.
- **Affected code**: root `package.json`, CI workflows, all `.mjs` files
  reformatted by Biome.
- **Contributor impact**: existing contributors must install pnpm. README
  migration section added.
- **User impact**: none (plugin distribution unchanged).

## Dependencies

- Phase 0 spike outcome on JSDoc vs full TypeScript determines the
  type-check approach. This proposal assumes JSDoc; if the spike chooses
  TypeScript, the proposal is amended in `tasks.md` (T6 changes shape) but
  spec deltas remain.
- `capture-v1-behavior` proposal SHOULD be merged before this one to
  establish the v1 baseline against which `ACP_PLUGIN_VERSION=v1` is
  validated. If not merged, this proposal documents v1 by reference to
  current behavior at commit SHA recorded in `design.md`.

## Risks and Mitigations

- **tsgo is pre-1.0**: ships breaking changes regularly. Mitigation: weekly
  CI job runs typecheck under both tsgo and stable tsc; if tsgo regresses,
  fall back to tsc with documented performance impact.
- **Biome reformats every file**: large diff makes git blame harder.
  Mitigation: dedicated formatting commit referenced in `.git-blame-ignore-revs`.
- **Husky 9 + pnpm interaction**: validated during spike. If issues
  surface during implementation, switch to lefthook.

## Estimated Effort

1.5 weeks one engineer. 1 week with effective LLM assistance.

## Validation

`openspec validate <change-id> --strict` SHALL pass. Spec deltas SHALL
parse cleanly; every Requirement SHALL have at least one Scenario;
no Requirement SHALL be missing SHALL/MUST language.
