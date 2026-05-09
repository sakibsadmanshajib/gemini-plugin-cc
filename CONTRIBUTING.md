# Contributing

## Toolchain

| Tool    | Version         | Purpose                                               |
| ------- | --------------- | ----------------------------------------------------- |
| Node.js | ≥ 18.18         | Runtime (CI matrix: 20.x + 22.x; engines floor 18.18) |
| pnpm    | ≥ 9             | Package manager                                       |
| vitest  | 2.x             | Test runner (unit + integration + property)           |
| tsgo    | pre-1.0 preview | Type-check via `@typescript/native-preview` + JSDoc   |
| Biome   | 1.9.x           | Lint + format                                         |
| husky   | 9.1.x           | Git hooks                                             |

Activate pnpm via corepack (preferred) or install globally:

```sh
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

## Local setup

```sh
pnpm install            # installs runtime deps (commander, raw-body) + devDeps
pnpm test               # vitest run (unit + integration + property)
pnpm test:unit          # unit only (fast — ~60s; useful inner loop)
pnpm test:int           # integration only
pnpm test:property      # fast-check property tests
pnpm typecheck          # tsgo --noEmit (fast; pre-1.0)
pnpm lint               # biome check
pnpm lint:fix           # biome check --write (formatter + safe lint autofixes)
pnpm format             # biome format --write
pnpm pack:check         # `npm pack --dry-run` — preview the publish tarball
```

If `pnpm typecheck` regresses unexpectedly, fall back to stable tsc:

```sh
pnpm run typecheck:fallback
```

The weekly CI job at `.github/workflows/tsgo-fallback.yml` runs the same fallback on Mondays at 06:00 UTC; a green run there confirms the codebase is portable across the two type-checkers.

## Pre-commit

`.husky/pre-commit` runs `biome check --write --staged` and re-stages any formatter fixes. To skip on CI, set `HUSKY=0` (already done in `.github/workflows/{install,test,tsgo-fallback,mutation-testing,npm-publish}.yml`).

## Type-check debt

`docs/typecheck-debt.md` lists files not yet annotated to a clean strict-mode pass. Pay debt down incrementally — see that file for the process.

## Feature flags

`ACP_PLUGIN_VERSION` selects v1 (current behavior) vs v2 (opt-in, post-modernize behavior). See `docs/feature-flags.md`.

## File layout

```
lib/
├── acp/             — JSON-RPC core (types, framing, generic client)
├── transport/       — CliTransport (the only transport since the 2026-05-08 CLI-only pivot)
├── backends/        — Per-backend declarations (gemini, codex, claude — all three exist)
├── runners/         — Stateless one-shot runners + dispatcher (claude-print/codex-exec/gemini-print)
├── server/          — OpenAI Chat Completions HTTP facade (openai-facade.mjs)
├── middleware/      — composeMiddleware + redaction/audit/cost/retry/fallback/cache
├── translate/       — Per-backend stream-json → SessionUpdate translators
├── cost/            — Cost recorder + aggregator + pricing
├── state/           — State-file schema + migrations
├── test-utils/      — MockBackend, conformance suite, in-memory transports, fixture replay
├── feature-flags.mjs
├── logger.mjs       — pino, stderr-only, redaction-first
├── tracing.mjs      — OpenTelemetry, lazy-loaded, opt-in
└── wire-log.mjs     — JSONL wire capture (env-gated by ACP_WIRE_LOG)

bin/                 — Three CLI entry points (artagon-agent, artagon-openai-server, artagon-stats)

plugins/{gemini,codex,claude}/  — Three host-installable plugin shells
├── .claude-plugin/
├── .codex-plugin/
├── commands/
├── agents/
├── hooks/
├── prompts/
├── schemas/
└── scripts/         — Legacy runtime: acp-broker.mjs, gemini-companion.mjs, lib/

tests/
├── unit/                — vitest unit tests (lib/* modules in isolation)
├── integration/         — vitest integration tests (real fs/git/network mocks)
├── property/            — fast-check property tests (framing, redaction, round-trip)
├── integration/fixtures/ — JSONL wire fixtures for replay
└── mocks/               — gemini-mock.mjs (ACP-mock binary for hermetic CI)

docs/
├── architecture.md          — High-level layer diagram + invariants
├── runners.md               — Stateless runner contract + TurnResult shape
├── openai-facade.md         — OpenAI Chat Completions HTTP facade reference
├── plugins.md               — Multi-plugin cross-pollination model
├── middleware-architecture.md — composeMiddleware + 6 middlewares
├── observability.md         — Logger / wire-log / OpenTelemetry tracing
├── transport-cli.md         — CliTransport reference
├── state-schema.md          — v1/v2 state-file format + migration
├── feature-flags.md         — ACP_PLUGIN_VERSION semantics (currently inert; see glossary)
├── cli-options-research.md  — Per-CLI flag taxonomy (claude/codex/gemini)
├── backends/{claude,codex,gemini}.md — Per-backend specifics
├── homebrew-tap.md          — Tap publish recipe + version-bump workflow
├── INSTALL.md               — Per-host install recipes
├── legacy-gemini-plugin.md  — Original /gemini:* command reference (broker-shared multi-turn)
├── agent-cli-design.md      — HISTORICAL — pre-pivot roadmap (kept as snapshot)
├── test-fixtures.md         — JSONL fixture format for replay
├── testing.md               — Test runner + property + mutation policy
├── mutation-debt.md         — Surviving stryker mutants by design
└── typecheck-debt.md        — Outstanding JSDoc annotation debt

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
