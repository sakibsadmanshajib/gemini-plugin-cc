# Spec Delta: toolchain

## ADDED Requirements

### Requirement: Package management uses pnpm

The repo SHALL use pnpm as its package manager. The lockfile SHALL be
`pnpm-lock.yaml`. The repo SHALL NOT contain `package-lock.json` or
`yarn.lock`.

#### Scenario: Fresh install on a clean checkout

- **GIVEN** a clean checkout of the repo on a machine with pnpm installed
- **WHEN** the contributor runs `pnpm install`
- **THEN** all dependencies install without errors
- **AND** `node_modules` uses pnpm's symlinked layout
- **AND** no `package-lock.json` is created

#### Scenario: Phantom dependency rejection at type-check

- **GIVEN** a `.mjs` file that imports a module not declared in any
  `package.json` `dependencies` or `devDependencies`
- **WHEN** the contributor runs `pnpm typecheck`
- **THEN** type-check exits non-zero
- **AND** the error references the offending import

#### Scenario: Frozen lockfile in CI

- **GIVEN** a CI job running `pnpm install --frozen-lockfile`
- **WHEN** `pnpm-lock.yaml` is out of date relative to `package.json`
- **THEN** the install fails fast
- **AND** the failure message identifies the lockfile mismatch

### Requirement: Type checking uses tsgo with JSDoc

The repo SHALL type-check JavaScript via JSDoc annotations using tsgo
(`@typescript/native-preview`). The type checker SHALL run with
`noEmit: true`. No build output (`dist/`, compiled `.js`) SHALL be
produced by the type-check step.

#### Scenario: Type error surfaces in pnpm typecheck

- **GIVEN** a JSDoc-typed function `/** @param {string} x */ function f(x) {}`
- **WHEN** another file calls `f(123)`
- **THEN** `pnpm typecheck` exits non-zero
- **AND** the error references the call site, the expected type
  (`string`), and the actual type (`number`)

#### Scenario: No build artifacts produced

- **GIVEN** `pnpm typecheck` completes successfully
- **WHEN** the contributor inspects the working tree
- **THEN** no `dist/` directory is present
- **AND** no `.js` files are emitted alongside `.mjs` sources
- **AND** runtime files remain `.mjs`

#### Scenario: Stable tsc fallback is verified weekly

- **GIVEN** the weekly cron job `tsgo-fallback.yml`
- **WHEN** the job runs on a Sunday
- **THEN** the same source is type-checked using stable `tsc`
- **AND** if tsc fails while tsgo passes, an alert issue is opened
- **AND** the alert includes the diff between the two checkers' output

### Requirement: Lint and format use Biome

The repo SHALL use Biome for both linting and formatting. Configuration
SHALL live in a single `biome.json` at the repo root. ESLint and Prettier
SHALL NOT be installed.

#### Scenario: Lint detects banned patterns

- **GIVEN** a `.mjs` file containing `console.log("debug")`
- **WHEN** `pnpm lint` runs
- **THEN** lint exits non-zero
- **AND** the error references the line containing `console.log`
- **AND** the error suggests using the project logger

#### Scenario: Format applied via pre-commit hook

- **GIVEN** an unformatted `.mjs` file is staged for commit
- **WHEN** the contributor runs `git commit`
- **THEN** husky invokes `pnpm exec biome check --staged`
- **AND** Biome reformats the staged content
- **AND** the commit proceeds with the reformatted content
- **AND** the working-tree copy of the file is updated to match

#### Scenario: Format reformatting commit is excluded from blame

- **GIVEN** the dedicated `biome check --apply` commit SHA
- **WHEN** the contributor runs `git blame` on a Biome-reformatted file
- **THEN** the reformatting commit is excluded
- **AND** blame attributes lines to their original authoring commits
- **AND** `.git-blame-ignore-revs` contains the formatting commit SHA

### Requirement: CI runs full check on every PR

The continuous integration workflow SHALL run lint, type-check, and tests
on every pull request, on a matrix covering Node 18.18, 20, and 22, on
both Linux and macOS. The matrix SHALL be the gate for merge.

#### Scenario: Lint failure blocks merge

- **GIVEN** a PR introducing a `console.log`
- **WHEN** CI runs
- **THEN** the lint step fails
- **AND** the merge button is disabled until the failure is resolved

#### Scenario: Cross-platform success

- **GIVEN** a PR with platform-specific code (e.g., path separators)
- **WHEN** CI runs the matrix
- **THEN** the job succeeds on all matrix entries
- **OR** failures are matrix-cell-specific and block merge

## ADDED Requirements (Dev Workflow Hooks)

### Requirement: Pre-commit hook runs Biome on staged files

The repo SHALL configure husky to run `pnpm exec biome check --staged` as a
pre-commit hook. The hook SHALL be installed automatically on
`pnpm install` via the `prepare` script.

#### Scenario: Hook installation on install

- **GIVEN** a fresh clone of the repo
- **WHEN** the contributor runs `pnpm install`
- **THEN** husky installs the `.husky/pre-commit` hook
- **AND** the hook is executable

#### Scenario: Hook bypass via --no-verify

- **GIVEN** a contributor running `git commit --no-verify`
- **WHEN** the commit is made
- **THEN** the pre-commit hook is skipped
- **AND** CI still enforces lint on the resulting PR
