# Spec Delta: monorepo-shape (modified)

This change MODIFIES the `monorepo-shape` capability introduced in
`modernize-toolchain`.

## MODIFIED Requirements

### Requirement: Workspace structure declared at repo root

The repo SHALL declare workspace conventions in `pnpm-workspace.yaml` at
the root. The file SHALL be the source of truth for workspace globs.
**Workspace globs SHALL include `lib` and `plugins/*` once those
directories exist with valid `package.json` files.** Pre-declared empty
globs SHALL NOT be present.

#### Scenario: Workspaces activated with lib package

- **GIVEN** the repo at the end of this change
- **WHEN** the contributor inspects `pnpm-workspace.yaml`
- **THEN** the file lists `lib` and `plugins/*`
- **AND** `pnpm install` discovers `lib` as `@artagon/acp-plugin-lib`
- **AND** `pnpm install` discovers each `plugins/<name>/` package

#### Scenario: Plugin shells share lib via workspace protocol

- **GIVEN** `plugins/gemini/package.json` declares
  `"@artagon/acp-plugin-lib": "workspace:*"`
- **WHEN** `pnpm install` runs
- **THEN** the symlinked workspace package is resolved
- **AND** changes in `lib/` are visible to `plugins/gemini/` without
  re-install

### Requirement: Toolchain configuration centralized at root

The toolchain configuration SHALL remain centralized at the repo root, unchanged from the form introduced in `modernize-toolchain`. This requirement is listed here for reference and continuity; behavior is identical to the originating spec.

#### Scenario: Root configuration files unchanged

- **GIVEN** the repo at the end of this change
- **WHEN** a contributor inspects `tsconfig.base.json`, `eslint.config.js`, and `prettier.config.cjs` at the root
- **THEN** their content matches what `modernize-toolchain` established
- **AND** package-level configs only `extends`/import the root configs
