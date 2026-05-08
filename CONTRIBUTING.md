# Contributing

## Toolchain

| Tool    | Version          | Purpose                                             |
| ------- | ---------------- | --------------------------------------------------- |
| Node.js | ≥ 18.18          | Runtime; tests use `node --test`                    |
| pnpm    | ≥ 9              | Package manager (formerly npm)                      |
| tsgo    | pinned (pre-1.0) | Type-check via `@typescript/native-preview` + JSDoc |
| Biome   | 1.9.4            | Lint + format                                       |
| husky   | 9.1.x            | Git hooks                                           |

Activate pnpm via corepack (preferred) or install globally:

```sh
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

## Local setup

```sh
pnpm install            # devDeps only; plugin has zero runtime deps
pnpm test               # node --test across tests/{unit,integration}
pnpm typecheck          # tsgo --noEmit (fast; pre-1.0)
pnpm lint               # biome check
pnpm lint:fix           # biome check --apply
pnpm format             # biome format --write
```

If `pnpm typecheck` regresses unexpectedly, fall back to stable tsc:

```sh
pnpm run typecheck:fallback
```

The weekly CI job at `.github/workflows/tsgo-fallback.yml` runs the same fallback on Mondays at 06:00 UTC; a green run there confirms the codebase is portable across the two type-checkers.

## Pre-commit

`.husky/pre-commit` runs `biome check --apply --staged` and re-stages any formatter fixes. To skip on CI, set `HUSKY=0` (already done in `.github/workflows/{install,test,tsgo-fallback}.yml`).

## Type-check debt

`docs/typecheck-debt.md` lists files not yet annotated to a clean strict-mode pass. Pay debt down incrementally — see that file for the process.

## Feature flags

`ACP_PLUGIN_VERSION` selects v1 (current behavior) vs v2 (opt-in, post-modernize behavior). See `docs/feature-flags.md`.

## File layout

```
lib/
├── acp/             — JSON-RPC core (types, framing, generic client)
├── transport/       — Transport implementations (cli; sdk + http planned)
├── backends/        — Per-backend declarations (gemini; codex + claude planned)
├── state/           — State-file schema + migrations
├── test-utils/      — MockBackend, conformance suite, in-memory transports, fixture replay
├── feature-flags.mjs
├── logger.mjs       — pino, stderr-only, redaction-first
├── tracing.mjs      — OpenTelemetry, lazy-loaded, opt-in
└── wire-log.mjs     — JSONL wire capture (env-gated by ACP_WIRE_LOG)

plugins/gemini/      — Plugin shell + legacy runtime (drives production today)
├── .claude-plugin/
├── .codex-plugin/
├── commands/
├── agents/
├── hooks/
├── prompts/
├── schemas/
└── scripts/         — Legacy runtime: acp-broker.mjs, gemini-companion.mjs, lib/

tests/
├── unit/
├── integration/
├── property/        — fast-check property tests (JSON-RPC framing, message round-trip)
├── fixtures/        — JSONL wire fixtures for replay
└── mocks/           — gemini-mock.mjs (ACP-mock binary for hermetic CI)

docs/
├── architecture.md      — High-level layer diagram
├── transport-cli.md     — CliTransport reference
├── state-schema.md      — v1/v2 state-file format + migration
├── test-fixtures.md     — JSONL fixture format for replay
├── feature-flags.md     — ACP_PLUGIN_VERSION semantics
├── testing.md           — Test runner + property + mutation policy
├── mutation-debt.md     — Surviving stryker mutants by design
└── typecheck-debt.md    — Outstanding JSDoc annotation debt

openspec/             — OpenSpec change proposals + capability specs
```

When adding code under `lib/`, see `docs/architecture.md` for which layer is the right home. New transports must pass `lib/test-utils/conformance.mjs`'s suite.

## OpenSpec workflow

Significant changes go through `openspec/changes/<name>/` with proposal, design, specs, and tasks. See `openspec/architecture.md` for the change ladder and `openspec/glossary.md` for terminology.

Validation gate before review or archive:

```sh
openspec validate <change-id> --strict
```

## Code of Conduct + Security

Project participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).
For vulnerability disclosure, follow [SECURITY.md](./SECURITY.md) — don't
file conduct or security issues in the public issue tracker.
