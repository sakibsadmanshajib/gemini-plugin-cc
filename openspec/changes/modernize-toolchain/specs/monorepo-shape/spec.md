# Spec Delta: monorepo-shape

## ADDED Requirements

### Requirement: Workspace structure declared at repo root

The repo SHALL declare workspace conventions in `pnpm-workspace.yaml` at
the root, even when only the root package exists. The file SHALL be the
source of truth for workspace globs. Additional workspace packages SHALL
be added to the globs as packages are introduced; pre-declared empty
globs SHALL NOT be present.

#### Scenario: Single-package phase

- **GIVEN** the repo at the end of this change
- **WHEN** the contributor inspects `pnpm-workspace.yaml`
- **THEN** the file exists
- **AND** the `packages:` list is empty (or contains only the root
  package as `'.'`)
- **AND** `pnpm install` succeeds without warnings about empty globs

#### Scenario: Adding the first workspace package later

- **GIVEN** a future change introducing `lib/` as a workspace package
- **WHEN** that change adds `'lib/*'` to `pnpm-workspace.yaml`
- **THEN** `pnpm install` discovers `lib/`
- **AND** root-level scripts can target `lib/` via `pnpm --filter ./lib`

### Requirement: Toolchain configuration centralized at root

All toolchain configuration files SHALL live at the repo root unless a
package has a documented reason for an override. The required root files
are:

- `package.json` (with `engines`, `pnpm`)
- `pnpm-workspace.yaml`
- `tsconfig.json`
- `biome.json`
- `.editorconfig`
- `.husky/`
- `.git-blame-ignore-revs`
- `.gitignore`

#### Scenario: New package inherits root config

- **GIVEN** a future workspace package added under `lib/`
- **WHEN** the package contains only `package.json` and `src/`
- **THEN** type-check, lint, format, and tests work without any
  per-package config files
- **AND** the package inherits root `tsconfig.json` and `biome.json`

#### Scenario: Override requires documentation

- **GIVEN** a package needs a per-package override (e.g., a different
  Biome rule)
- **WHEN** that override is added
- **THEN** the package contains an override file (e.g., `biome.json`)
- **AND** the override file's first line is a comment referencing
  `docs/per-package-overrides.md` with rationale
- **AND** `docs/per-package-overrides.md` lists the override and reason
