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

## Unified-facade daemon (2026-05-11)

The `artagon-openai-server` daemon is a long-lived process operators can run
once to serve all slash-command requests. Instead of cold-spawning a CLI per
turn, slash-commands route HTTP to the daemon, which owns warm streaming
runners for each backend.

- **Discovery** — daemon writes `$XDG_STATE_HOME/artagon-agent-cli-plugin/facade-endpoint.json` (mode 0o600, parent dir 0o700) on listen, deletes on close. Readers gate on `lstat + isFile + uid match + pid liveness`; symlinks are refused.
- **Auto-start** — `lib/server/auto-start.mjs::autoStartFacade` spawns the daemon when a slash-command finds no live manifest. proper-lockfile serializes concurrent spawns; spawn errors are routed to a log file under XDG state.
- **Stale-manifest recovery** — when `runViaFacade` hits `ECONNREFUSED/ENOTFOUND/EHOSTUNREACH/ENETUNREACH`, `compareAndDeleteManifest` atomically renames the manifest to a unique tombstone, verifies pid+port match the captured manifest, and either commits the delete or restores via `link()`. `ECONNRESET` is excluded — it can fire mid-stream while the daemon stays up for other clients.
- **Circuit breaker** — `$XDG_STATE_HOME/artagon-agent-cli-plugin/auto-start-failures.json` tracks daemon spawn failures in a 5-minute rolling window. Three failures → next `autoStartFacade` refuses with an actionable message. Successful spawn clears the log. Stale entries pruned on read.
- **Tombstone sweep** — `autoStartFacade` scans for `facade-endpoint.json.tomb.*` files older than 1 hour and unlinks them, recovering disk after a slash-command SIGKILL between rename and cleanup.
- **/admin/status** — bearer-gated (or unauthed when `apiKey` is unset) GET endpoint reporting pid, uptime, per-supervisor health, and SQLite recorder stats. `lastError` is redacted to a closed `LastErrorCode` enum (see `lib/runners/streaming/types.mjs`) — never raw `err.message`, so spawn paths and auth hints stay in the daemon's stderr log.
- **Machine-readable errors** — dispatcher facade-failure throws carry `.code: "FACADE_UNREACHABLE" | "FACADE_RACE_REPLACED" | "FACADE_CONN_RESET"` so downstream catch blocks switch on the class rather than substring-matching prose.

See `docs/openai-facade.md` for the endpoint reference and `lib/server/facade-endpoint.mjs` for the manifest contract.

## Where to add things

| Want to add…                     | Touch…                                                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A new backend (Bedrock, custom)  | `lib/backends/<name>.mjs` — declare modelAliases + `transports.cli` + `setupHints`; export `build<Name>Args`                                           |
| A new launch-time CLI flag       | The backend's `BackendConfig` typedef + its `build<Name>Args` function + a unit test in tests/unit/                                                    |
| A new transport (gRPC, MCP)      | `lib/transport/<name>.mjs`, conform to `ClientTransport`, run conformance suite                                                                        |
| A new slash command              | `plugins/<plugin>/commands/<verb>.md` + handler in `gemini-companion.mjs` or the future v2 dispatcher                                                  |
| A new middleware                 | `lib/middleware/<name>.mjs`, conform to the `Middleware` typedef in `compose.mjs`                                                                      |
| Observability (logging, tracing) | `lib/logger.mjs`, `lib/tracing.mjs` — already wired, just add child-loggers                                                                            |
| A new spec capability            | `openspec/changes/<name>/specs/<capability>/spec.md`                                                                                                   |
| A new `LastErrorCode` bucket     | `lib/runners/streaming/types.mjs::LastErrorCode` union + `lib/runners/streaming/registry.mjs::classifyLastError` regex + `docs/openai-facade.md` table |

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
- **`LastErrorCode` is the wire contract** — `/admin/status` exposes only the closed enum from `lib/runners/streaming/types.mjs`. Future changes that pass raw `err.message` to operators must update the union AND the classifier in lockstep; the typecheck makes the wire shape exhaustive.
- **Manifest deletion is compare-and-set** — `compareAndDeleteManifest` atomically claims the manifest via rename before verifying pid+port; never use bare `deleteManifest` from the dispatcher's wipe path.

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
