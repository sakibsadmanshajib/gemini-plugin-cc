# Tasks: add-unified-acp-server-with-mcp-aggregation

## Phase 0 — Quick win (broker-aware gemini cross-driver)

Independent of all other phases. Lands first.

- [ ] T0.1 — `lib/transport/broker-socket.mjs`: add `findActiveBroker(cwd)`
      and `runGeminiViaBroker(endpoint, options)` exports
- [ ] T0.2 — `lib/runners/dispatch.mjs`: when GEMINI is the target, probe
      for a broker session before falling through to `runGeminiPrint`
- [ ] T0.3 — `lib/cost/recorder.mjs`: cost record gains `transport: "broker" | "cli"`
- [ ] T0.4 — `tests/unit/broker-probe.test.mjs`: probe returns null on
      missing/invalid state files; rejects mismatched-uid sockets;
      accepts current-uid live brokers
- [ ] T0.5 — `tests/integration/dispatch-broker-aware.test.mjs`: spawn a
      gemini broker, dispatch a turn, assert `transport === "broker"`
- [ ] T0.6 — `tests/integration/dispatch-broker-fallback.test.mjs`: stub
      `findActiveBroker` to return a stale endpoint; assert dispatcher
      logs once and falls back to cold start
- [ ] T0.7 — Update `docs/architecture.md` to mention the broker-aware path

## Phase 1 — Unified ACP server

### 1A. Dependencies

- [ ] T1.1 — Add `@zed-industries/agent-client-protocol` (exact pin) to
      package.json
- [ ] T1.2 — Add `@modelcontextprotocol/sdk` (exact pin) to package.json
- [ ] T1.3 — Add `@zed-industries/claude-code-acp` (exact pin) to
      package.json — note license + size in CHANGELOG
- [ ] T1.4 — Run `pnpm pack:check` to verify tarball-size impact stays
      reasonable; document new size in CHANGELOG

### 1B. ACP server core

- [ ] T1.5 — `lib/server/acp-server.mjs`:
  - export `createAcpServer(options)` returning `{ listen, close }`
  - wire `AgentSideConnection` from `@zed-industries/agent-client-protocol`
  - implement `initialize`, `authenticate`, `session/new`, `session/load`,
    `session/prompt`, `session/cancel`
  - persist endpoint manifest at `$XDG_STATE_HOME/.../acp-server.json`
- [ ] T1.6 — `lib/server/acp-backend-router.mjs`:
  - resolve backend from prompt model field via `lib/backends/*/aliases.mjs`
  - per-session sticky binding
  - fallback to `--backend` flag or `ARTAGON_ACP_BACKEND` env
- [ ] T1.7 — `lib/server/acp-session-store.mjs`:
  - persist per-session state at `$XDG_STATE_HOME/.../acp-sessions/<id>.json`
  - mode 0o600; refuse cross-uid hand-off

### 1C. Per-backend adapters

- [ ] T1.8 — `lib/server/acp-backend-adapter/types.d.mjs`:
  - JSDoc-typed `BackendAdapter` interface (`start`, `prompt`, `cancel`,
    `close`, `health`)
- [ ] T1.9 — `lib/server/acp-backend-adapter/gemini.mjs`:
  - spawns `gemini --acp` once
  - reuses `lib/transport/cli.mjs` and `lib/acp/client.mjs`
  - pass-through ACP method calls
- [ ] T1.10 — `lib/server/acp-backend-adapter/codex.mjs`:
  - spawns `codex app-server` once
  - imports `lib/translate/codex-app-server.mjs`
  - vendor `codex app-server generate-json-schema --out
lib/backends/codex/app-server-schema/`
- [ ] T1.11 — `lib/translate/codex-app-server.mjs`:
  - schema-validated translation in both directions
  - golden fixtures captured from a real `codex app-server` session
- [ ] T1.12 — `lib/server/acp-backend-adapter/claude.mjs`:
  - delegates to `@zed-industries/claude-code-acp` via stdio
  - fork-readiness: documented in inline comment, ~500-line ceiling
- [ ] T1.13 — `lib/server/acp-backend-supervisor.mjs`:
  - per-backend lifecycle: start, restart on crash (5 attempts max,
    exponential backoff), 5-min idle timeout
  - health labels: `starting | healthy | degraded | restarting | dead`

### 1D. Bin entry point

- [ ] T1.14 — `bin/artagon-acp-server.mjs`:
  - mirror `bin/artagon-openai-server.mjs` structure
  - flags: `--listen <stdio|unix://...|ws://...>`, `--backend`,
    `--api-key`, `--api-key-file`, `--auto-key`, `--auto-key-rotate`,
    `--auto-key-store`, `--mcp-aggregation`, `--idle-ms`
  - graceful shutdown on SIGINT/SIGTERM with 10s safety timer
- [ ] T1.15 — `package.json`: register `artagon-acp-server` bin
- [ ] T1.16 — Wire `--auto-key` reuse: import from
      `lib/server/api-key-store.mjs` (already exists)

### 1E. Tests for Phase 1

- [ ] T1.17 — `tests/unit/acp-backend-router.test.mjs`:
  - model-hint resolution for each backend
  - per-session sticky binding
  - default fallback
- [ ] T1.18 — `tests/unit/acp-backend-adapter-gemini.test.mjs`:
  - mocked child; start/restart/idle/health
- [ ] T1.19 — `tests/unit/acp-backend-adapter-codex.test.mjs`:
  - mocked child; protocol translation via golden fixtures
- [ ] T1.20 — `tests/unit/acp-backend-adapter-claude.test.mjs`:
  - mocked `@zed-industries/claude-code-acp` child
- [ ] T1.21 — `tests/unit/acp-session-store.test.mjs`:
  - persistence; uid mismatch rejection; mode 0o600
- [ ] T1.22 — `tests/integration/acp-server-end-to-end.test.mjs`:
  - spawn artagon-acp-server child; drive it from
    `@zed-industries/agent-client-protocol`'s ClientSideConnection
  - send prompt to each backend (mocked or via the existing
    gemini-mock testbench pattern)
- [ ] T1.23 — `tests/integration/acp-server-crash-recovery.test.mjs`:
  - kill a backend daemon mid-session; next turn restarts cleanly
- [ ] T1.24 — `tests/integration/acp-server-auto-key.test.mjs`:
  - `--auto-key` set; request without bearer token rejected
- [ ] T1.25 — `tests/integration/acp-server-conformance.test.mjs`:
  - run `@zed-industries/agent-client-protocol`'s included
    conformance tests (if shipped) against our server

## Phase 2 — MCP aggregation

### 2A. Discovery

- [ ] T2.1 — `lib/server/mcp-discovery.mjs`:
  - read `~/.claude/settings.json` `mcpServers`
  - read `~/.codex/config.toml` `[mcp_servers.*]`
  - read `~/.gemini/settings.json` `mcpServers`
  - return a unified `Map<serverName, ServerSpec>`
- [ ] T2.2 — `tests/unit/mcp-discovery.test.mjs`:
  - parse each format with golden fixtures
  - tolerate missing files / invalid sections
  - dedupe servers seen in multiple backends

### 2B. Aggregator

- [ ] T2.3 — DECISION: vendor 300-line aggregator vs. depend on
      `mcp-proxy-server` (adamwattis). Evaluate code quality,
      maintenance, license. Documented in design.md.
- [ ] T2.4 — `lib/server/mcp-aggregator.mjs`:
  - if vendor: implement using `@modelcontextprotocol/sdk` Client
    - Server primitives
  - otherwise: thin wrapper around chosen dep
  - namespace tools/resources/prompts as `<server>:<name>`
  - route `tools/call` etc. by ns prefix
- [ ] T2.5 — `tests/unit/mcp-aggregator.test.mjs`:
  - namespace handling
  - collision detection (same name across servers — must namespace
    rather than merge)
  - routing tools/call to correct underlying server
- [ ] T2.6 — `tests/integration/mcp-aggregator-end-to-end.test.mjs`:
  - register a fake MCP server in claude's config
  - invoke its tool through a session bound to gemini
  - verify the call lands

### 2C. Wire into ACP server

- [ ] T2.7 — `lib/server/acp-server.mjs`: when `mcpAggregation: true`,
      forward `tools/list`, `tools/call`, `resources/list`,
      `resources/read`, `prompts/list`, `prompts/get` to the aggregator
- [ ] T2.8 — Per-server allow/deny list at
      `$XDG_CONFIG_HOME/artagon-agent-cli-plugin/mcp-allowlist.json`:
  - default: allow all configured servers
  - operator can disable specific servers
- [ ] T2.9 — `tests/integration/acp-server-mcp-aggregation.test.mjs`:
  - end-to-end with aggregation on; verify tools list union
  - end-to-end with aggregation off; verify no tools surfaced
  - verify allow/deny list

## Phase 3 — Cross-cutting

### 3A. Cost telemetry

- [ ] T3.1 — `lib/cost/recorder.mjs`:
  - `transport` field gains the `acp-server` value
  - `mcp_tools_used` array added
- [ ] T3.2 — `bin/artagon-stats.mjs`:
  - text-summary table adds an "ACP server" column
  - JSON output adds the new fields
- [ ] T3.3 — `tests/unit/cost-record-acp.test.mjs`:
  - records emit `transport: "acp-server"` when going through ACP
  - `mcp_tools_used` populated when tools fired

### 3B. Documentation

- [ ] T3.4 — `README.md`:
  - new "Unified ACP server" section under Install
  - the "what's running where" mental model diagram
  - operator onboarding workflow
- [ ] T3.5 — `docs/architecture.md`:
  - update the architecture diagram to show the ACP server topology
  - explain backend lifecycle
- [ ] T3.6 — `docs/acp-server.md` (new):
  - reference for the new bin
  - configuration matrix
  - example Zed integration recipe
- [ ] T3.7 — `docs/mcp-aggregation.md` (new):
  - the namespacing model
  - allow/deny configuration
  - security considerations
- [ ] T3.8 — `CHANGELOG.md`:
  - new entries for each phase

### 3C. Operator quality-of-life

- [ ] T3.9 — `bin/artagon-agent.mjs`:
  - new `--via-acp` flag: route through a running artagon-acp-server
    instead of cold-start CLI subprocess
  - reads endpoint manifest from `$XDG_STATE_HOME/.../acp-server.json`
- [ ] T3.10 — `tests/integration/artagon-agent-via-acp.test.mjs`:
  - acp-server running; `--via-acp` succeeds
  - acp-server not running; `--via-acp` errors with actionable message

## Validation

- [ ] T4.1 — `openspec validate add-unified-acp-server-with-mcp-
    aggregation --strict` passes
- [ ] T4.2 — Full test suite green: unit + integration + property +
      conformance
- [ ] T4.3 — `pnpm typecheck` clean
- [ ] T4.4 — `pnpm lint` clean
- [ ] T4.5 — `pnpm vendor:lib:check` in sync
- [ ] T4.6 — `pnpm pack:check` succeeds; tarball size delta documented
      in CHANGELOG
- [ ] T4.7 — End-to-end: real Zed editor connecting via ACP, each
      backend selectable, one real MCP tool call from a session bound
      to a different backend

## Notes on phasing

- **Phase 0** is independent and ships first (1 day).
- **Phase 1** (1.5-2 weeks) lands the ACP server WITHOUT MCP
  aggregation; that surface is already useful for Zed integration
  and for our own `--via-acp` flag.
- **Phase 2** (3-5 days) adds MCP aggregation on top of Phase 1.
- **Phase 3** (2-3 days) ships the operator UX and observability.

Each phase is a separate commit/PR. Phase 0 and Phase 1 can be
shipped to main; Phase 2 and Phase 3 build on top.
