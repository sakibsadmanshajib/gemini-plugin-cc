# Architecture

A 1-page tour of the runtime layers. For deep detail see the per-capability spec files under `openspec/specs/` and the OpenSpec change proposals under `openspec/changes/`.

## Layered shape

```
┌──────────────────────────────────────────────────────────────┐
│  Host (Claude Code, Codex CLI, future Gemini CLI)            │
│  - registers plugins from marketplace.json                   │
│  - issues slash commands                                     │
└─────────────────┬────────────────────────────────────────────┘
                  │
┌─────────────────▼────────────────────────────────────────────┐
│  Plugin shell             plugins/gemini/                    │
│  - .claude-plugin/plugin.json (+ .codex-plugin/ byte-eq)     │
│  - commands/<verb>.md, agents/, hooks/, prompts/, schemas/   │
│  - scripts/gemini-companion.mjs (CLI entry)                  │
│  - scripts/lib/gemini.mjs (call sites — all on v2 layer)     │
└─────────────────┬────────────────────────────────────────────┘
                  │ imports `#lib/*` (subpath imports map)
┌─────────────────▼────────────────────────────────────────────┐
│  Backends                lib/backends/                       │
│  - gemini.mjs   — modelAliases, cli + brokerSocket factory   │
│  - codex.mjs    — modelAliases, cli factory                  │
│  - claude.mjs   — modelAliases, cli factory (stub: Claude    │
│                   CLI lacks ACP, transport surfaces an       │
│                   actionable error on start())               │
│  Each exports `build<X>Args(config)` — pure argv builders     │
│  pinned by tests/unit/{cli-args-builders,claude-args-builder}│
└─────────────────┬───────────────────────────────────────────┘
                  │ creates a transport per session
┌─────────────────▼───────────────────────────────────────────┐
│  Transports              lib/transport/                      │
│  - cli.mjs           — subprocess + stdio framing            │
│  - broker-socket.mjs — Unix-socket / named-pipe to broker    │
│  - broker-probe.mjs  — discover an existing broker for cwd   │
│                        (Phase 0 warm-path: dispatcher uses   │
│                        this to skip cold-start when a live   │
│                        broker is already running)            │
│  All conform to `ClientTransport` (lib/acp/client.mjs).      │
│  CLI-only architecture: no in-process SDK transport, no HTTP │
│  app-server transport. Each backend launches its CLI binary  │
│  with backend-specific optimization options.                 │
└─────────────────┬───────────────────────────────────────────┘
                  │ wraps an AcpSession
┌─────────────────▼───────────────────────────────────────────┐
│  ACP core                lib/acp/                            │
│  - types.mjs    — JSDoc typedefs (AcpSession, JsonRpcMessage)│
│  - framing.mjs  — newline-delimited JSON, partial buffer     │
│  - client.mjs   — request/response correlation, dispatch.    │
│                   Rejects pending requests on `worker_missing` │
│                   so spawn-failures fail fast instead of     │
│                   hanging at the caller's timeout.            │
└─────────────────┬───────────────────────────────────────────┘
                  │ verified by
┌─────────────────▼───────────────────────────────────────────┐
│  Test infrastructure     lib/test-utils/                     │
│  - mock-backend.mjs     — reference ClientTransport          │
│  - in-memory-transport.mjs — paired EventEmitter halves      │
│  - fake-acp-backend.mjs — scriptable backend on transport    │
│  - fixture-replayer.mjs — JSONL replay (matches wire-log)    │
│  - conformance.mjs      — runConformanceSuite(name, factory) │
└──────────────────────────────────────────────────────────────┘

                  ─── Cross-cutting ────────────────────────

┌─────────────────────────────────────────────────────────────┐
│  Middleware              lib/middleware/                     │
│  - compose.mjs    — redaction-first invariant + composer     │
│  - redaction.mjs  — secrets/PII scrubbing (always index 0)   │
│  - audit.mjs      — JSONL append-only audit log              │
│  - cost.mjs       — token + call accounting (Codex/Claude/   │
│                     Gemini result-shape extractors)           │
│  - retry.mjs      — exponential backoff for transient errors │
│  - fallback.mjs   — model swap on overload                   │
│  - cache.mjs      — content-addressed (method+params+HEAD)   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Observability           lib/                                │
│  - logger.mjs    — pino, stderr-only, redaction-first        │
│  - wire-log.mjs  — JSONL of every JSON-RPC frame, env-gated  │
│  - tracing.mjs   — OpenTelemetry, lazy-loaded, opt-in        │
│  - feature-flags.mjs — ACP_PLUGIN_VERSION (v1/v2 plumb)      │
└─────────────────────────────────────────────────────────────┘
```

## Where to add things

| Want to add…                     | Touch…                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A new backend (Bedrock, custom)  | `lib/backends/<name>.mjs` — declare modelAliases + `transports.cli` + `setupHints`; export `build<Name>Args` |
| A new launch-time CLI flag       | The backend's `BackendConfig` typedef + its `build<Name>Args` function + a unit test in tests/unit/          |
| A new transport (gRPC, MCP)      | `lib/transport/<name>.mjs`, conform to `ClientTransport`, run conformance suite                              |
| A new slash command              | `plugins/<plugin>/commands/<verb>.md` + handler in `gemini-companion.mjs` or the future v2 dispatcher        |
| A new middleware                 | `lib/middleware/<name>.mjs`, conform to the `Middleware` typedef in `compose.mjs`                            |
| Observability (logging, tracing) | `lib/logger.mjs`, `lib/tracing.mjs` — already wired, just add child-loggers                                  |
| A new spec capability            | `openspec/changes/<name>/specs/<capability>/spec.md`                                                         |

## Key invariants

- **stdout is the wire** — subprocess stdout carries JSON-RPC; logs go to stderr; the `Stdio Discipline` requirement in `gemini-plugin-baseline` pins this per-component.
- **AcpSession is the contract** — all transports and backends conform; verified by `runConformanceSuite`.
- **CLI-only adapters** — backends launch their CLI binary in ACP mode (or, for Claude pending upstream support, surface a "not yet supported" error). No SDK or HTTP transports — that surface area was removed; see `docs/cli-options-research.md` for the per-backend flag taxonomy.
- **Argv builders are pure functions** — `buildGeminiArgs`, `buildCodexArgs`, `buildClaudeArgs` are exported and unit-tested. They throw on invalid combinations rather than silently dropping options.
- **Pending requests reject on `worker_missing`** — spawn failures and unexpected child exits propagate as rejected promises immediately, not at caller-timeout.
- **State schema is versioned** — v1 → v2 is field-additive only; `lib/state/migrate.mjs` reads any version.
- **Subpath imports** — runtime modules import via `#lib/*` (Node subpath imports configured in `package.json::imports`); deep relative paths like `../../../../lib/...` are forbidden.
- **Wire log = fixture format** — `ACP_WIRE_LOG=/path.jsonl` produces a file directly consumable by `replayFixture()` in tests.
- **Redaction is index 0** — middleware composer enforces `redaction` first; throws in dev if violated.

## Reading order for newcomers

1. `openspec/architecture.md` (high-level multi-backend roadmap)
2. `openspec/glossary.md` (terminology — ACP, transport, backend, broker)
3. This file
4. `docs/cli-options-research.md` (per-backend CLI flag inventory: session, resume, stateless, output-format)
5. `docs/transport-cli.md` (CliTransport reference)
6. `docs/backends/{gemini,codex,claude}.md` (per-backend specifics)
7. `docs/state-schema.md` (state-file format + migration)
8. `docs/test-fixtures.md` (JSONL fixture format for replay)
9. `docs/middleware-architecture.md` (composer + redaction-first invariant)
10. `docs/observability.md` (logger / wire-log / tracing — env-gated, opt-in)
11. `docs/runners.md` (stateless runners for Claude `--print` + Codex `exec --json`)
12. `docs/plugins.md` (multi-plugin cross-pollination model: each plugin drives the OTHER backends)
13. `lib/test-utils/conformance.mjs` (executable contract for all transports)
