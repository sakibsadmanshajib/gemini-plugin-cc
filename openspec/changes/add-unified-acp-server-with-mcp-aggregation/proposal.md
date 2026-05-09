# Add Unified ACP Server with MCP Aggregation

## Why

Today the artagon suite **consumes** backends (claude, codex, gemini)
via cold-start CLI subprocesses. Every cross-driver call pays the
~3-7s startup tax. Three of those backends already have long-running
server modes; one has a published ACP adapter. The ecosystem has
mature TypeScript libraries for the relevant protocols. We're not
using any of it.

This change inverts the architecture: artagon **becomes a server**
that:

1. **Speaks ACP** to upstream clients (Zed, future tools, our own
   future agentic shell). Built on
   `@zed-industries/agent-client-protocol` — the same library Zed
   uses for its own ACP integration.
2. **Routes to backends** via long-lived per-backend connections:
   - Gemini → `gemini --acp` (already-an-ACP-server, native)
   - Codex → `codex app-server` + a translator from Codex's
     experimental app-server JSON-RPC dialect to ACP
   - Claude → `@zed-industries/claude-code-acp` (existing,
     published, 14k weekly downloads — the Zed ecosystem has
     already done the claude-as-ACP work)
3. **Aggregates MCP tools** across backends. Each backend has its
   own MCP config (claude's `~/.claude/`, codex's `~/.codex/`,
   gemini's `~/.gemini/`). We discover all configured MCP servers,
   spawn or proxy each one ONCE via `@modelcontextprotocol/sdk`,
   and present a unified tool catalog through our ACP server. A
   tool registered with claude becomes callable via codex, and
   vice-versa.

The cold-start tax goes from per-call to per-server-lifetime. An
ACP client sends N turns; backends are spawned at most once during
that session.

## Why now (over the warm-path-runners proposal)

The sibling proposal `add-warm-path-runners` is **superseded by this
one**. Its options 1/2/3 attacked the same problem from inside the
existing dispatcher. This proposal solves it at the architectural
boundary instead:

| `add-warm-path-runners` (superseded)    | `add-unified-acp-server` (this)                              |
| --------------------------------------- | ------------------------------------------------------------ |
| Adds warm paths into `runStatelessTurn` | Builds a separate long-lived server that owns the warm paths |
| Each backend wired ad-hoc               | Single uniform ACP surface                                   |
| MCP tools stay per-backend              | MCP tools aggregated across backends                         |
| Cross-driver only (our own scripts)     | Any ACP client works (Zed, future)                           |
| Custom JSON-RPC framing                 | `@zed-industries/agent-client-protocol`                      |

Option 1 from the superseded proposal (broker-aware gemini cross-
driver) **still ships independently** as a 1-day quick win — it lives
inside the existing dispatcher and is orthogonal to the new ACP
server. It's listed under "Phase 0" below.

## What Changes

### Phase 0 — Quick win (independent of the rest)

Same as option 1 of the superseded proposal: route gemini cross-
driver through the existing broker when one is alive. ~1 day, no
new dependencies, lands first.

### Phase 1 — Unified ACP server (new bin)

- **`bin/artagon-acp-server.mjs`** — new bin alongside
  `artagon-openai-server`. Listens for ACP clients on:
  - `stdio://` (default — for Zed-style spawn-and-pipe)
  - `unix://<path>` (for socket-based clients)
  - `ws://host:port` (for browser/network clients via WebSocket)
- **`lib/server/acp-server.mjs`** — server core. Built on
  `@zed-industries/agent-client-protocol`'s `AgentSideConnection`.
  Routes incoming `session/prompt` to the configured backend.
- **`lib/server/acp-backend-router.mjs`** — picks a backend from:
  - the model field on the prompt (`model: "claude-sonnet-4-6"` →
    claude; `model: "gpt-5"` → codex; etc.) using the existing
    `lib/backends/*/aliases.mjs`
  - or the `--backend` server flag
  - or the `ARTAGON_ACP_BACKEND` env var
- **`lib/server/acp-backend-adapter.mjs`** — wraps each backend as
  a long-lived ACP-speaking child:
  - `geminiBackendAdapter`: spawns `gemini --acp`, exposes
    `runTurn(opts) → AsyncIterator<SessionUpdate>`. Pass-through
    of ACP method calls — no translation needed.
  - `codexBackendAdapter`: spawns `codex app-server`, translates
    Codex JSON-RPC dialect → ACP via
    `lib/translate/codex-app-server.mjs` (NEW). Schema vendored
    from `codex app-server generate-json-schema --out ...` and
    pinned to a known codex version range.
  - `claudeBackendAdapter`: delegates to
    `@zed-industries/claude-code-acp`. We don't reinvent the
    claude-as-ACP wrapper; we depend on the published one and
    pin its version.

Each adapter:

- starts a single child on first use
- multiplexes turns through that child
- restarts on crash (exponential backoff, max 5 attempts)
- exits the child after 5 min idle (configurable via
  `ARTAGON_ACP_IDLE_MS`)
- surfaces health labels: `starting | healthy | degraded | restarting | dead`

### Phase 2 — MCP aggregation layer

- **`lib/server/mcp-aggregator.mjs`** — discovers MCP configurations
  from each backend's settings dirs:
  - claude: `~/.claude/settings.json` (`mcpServers` field)
  - codex: `~/.codex/config.toml` (`[mcp_servers.*]` sections)
  - gemini: `~/.gemini/settings.json`
- For each unique MCP server URL/command, spawn or connect ONCE via
  `@modelcontextprotocol/sdk`'s `Client` class.
- Aggregate the union of:
  - tools (with namespace prefix to disambiguate same-name tools
    across servers: `<server>:<tool>`)
  - resources
  - prompts
- Expose the union as a single MCP server that the ACP backend
  adapters can call. When backend X invokes a tool that's actually
  hosted by backend Y's MCP, the aggregator routes the call.
- **Reuses an existing aggregator** rather than rebuilding:
  - First choice: `mcp-proxy-server` (adamwattis) — has the
    aggregation pattern. Evaluate whether to depend on it or vendor
    its core 200-line aggregator.
  - Second choice: roll a thin aggregator using
    `@modelcontextprotocol/sdk` primitives. ~300 lines.
  - Decision deferred to Phase 2 implementation; both options
    documented in the design doc.

### Phase 3 — Cross-cutting concerns

- **Persistence**: per-backend warm sessions are tracked in
  `$XDG_STATE_HOME/artagon-agent-cli-plugin/acp-sessions/<backend>.pid`
  for orphan detection. Same pattern as today's runner pid-files.
- **Authentication**: artagon-acp-server gets the same `--auto-key`
  flag as artagon-openai-server, but bound to ACP-level auth (not
  HTTP). When `--auto-key` is set, ACP clients must present a
  bearer token; same Keychain or 0o600 file storage.
- **Observability**: per-turn cost records gain `transport: "acp-
server"` and `mcp_tools_used: ["<server>:<tool>", ...]`. The
  existing `artagon-stats` text + JSON breakdowns add an "ACP
  server" column.

## Dependencies (npm packages, NEW)

| Package                                 | Use                                         | License    | Weekly downloads (May 2026) |
| --------------------------------------- | ------------------------------------------- | ---------- | --------------------------- |
| `@modelcontextprotocol/sdk`             | MCP server/client primitives                | MIT        | 1.5M+                       |
| `@zed-industries/agent-client-protocol` | ACP server framework                        | Apache-2.0 | 14k                         |
| `@zed-industries/claude-code-acp`       | Claude-as-ACP adapter                       | Apache-2.0 | smaller; published          |
| `vscode-jsonrpc`                        | Optional, for any custom JSON-RPC endpoints | MIT        | very high; battle-tested    |

These are pinned to exact versions in `package.json` (matches the
existing project policy of exact-version dependencies). Each new dep
adds to the `pack:check` budget; we re-run the tarball-size check
after wiring them.

We considered and rejected:

- **Building ACP from scratch**: `@zed-industries/agent-client-
protocol` already exists, is maintained, and is what other ACP
  clients (Zed) use. Reinventing means drift risk.
- **uWebSockets.js**: faster, but C++ binding pulls in build-time
  toolchain requirements. Plain `node:net` + `vscode-jsonrpc` is
  10ms slower per RPC and zero compilation requirements.
- **Custom MCP aggregator**: an existing one (`mcp-proxy-server`)
  works; rolling our own is busywork. We accept whichever has the
  cleanest TypeScript types.

## Impact

### Affected specs

- `unified-acp-server` (new capability — this proposal's spec)
- `dispatch` (touched): `runStatelessTurn` gains a `transport:
"acp-server"` path that targets a running artagon-acp-server
- `cost-telemetry` (touched): `transport` field gains the
  `acp-server` value; `mcp_tools_used` array added

### Affected code

- `bin/artagon-acp-server.mjs` (new)
- `lib/server/acp-server.mjs` (new)
- `lib/server/acp-backend-router.mjs` (new)
- `lib/server/acp-backend-adapter.mjs` (new)
- `lib/server/mcp-aggregator.mjs` (new)
- `lib/translate/codex-app-server.mjs` (new — Codex app-server
  protocol → ACP)
- `lib/runners/dispatch.mjs` (touched — adds optional
  `transport: "acp-server"` branch)
- `package.json` (touched — new deps)
- `README.md`, `docs/architecture.md` (touched — describe the new
  topology)
- A handful of new tests (unit + integration; conformance against
  ACP spec)

### Behavior

- **Default behavior is invariant.** The new bin is opt-in. Today's
  `artagon-agent` and `artagon-openai-server` paths are unchanged.
- **A new operator workflow becomes possible**:

  ```sh
  # Start once.
  artagon-acp-server --auto-key &

  # Use forever — every backend stays warm:
  zed --connect acp+stdio://...           # Zed editor
  artagon-agent --via-acp claude "..."    # opt-in via flag
  ```

- **Cross-backend MCP**: a tool registered with one backend's MCP
  config becomes accessible to the others when invoked via the
  artagon-acp-server. (When invoked via the cold-start runners, no
  change.)

### Performance

- Cold start: paid once per server lifetime per backend (~3-5s for
  the first call to each backend; effectively zero thereafter).
- Per-turn warm cost: ~50-200ms RPC + model time. ~10× faster than
  cold-start path.
- Memory overhead: each backend daemon ~50-200MB resident. Up to
  ~600MB for all three backends warm. Operator can limit by
  configuring which backends to keep warm.

### Security

- **MCP aggregation expands attack surface**. A malicious tool
  registered with one backend becomes callable through the others
  via this server. Mitigation:
  - Tools are namespaced (`<server>:<tool>`) — clients see exactly
    which server hosts each tool.
  - Per-server allow/deny list via
    `$XDG_CONFIG_HOME/artagon-agent-cli-plugin/mcp-allowlist.json`
    (default deny on first-seen; operator approves).
  - `lib/middleware/redaction.mjs` continues to scrub credentials
    from tool args/results before passing them between backends.
- **Auth**: `--auto-key` provisions a 512-byte CSPRNG bearer
  token (same as artagon-openai-server). Constant-time compared
  per ACP request.
- **No cross-uid access**: per-backend session pid-files refuse
  hand-off to a different uid; mismatched ownership errors out.

## Risks and Mitigations

| Risk                                                                                    | Mitigation                                                                                                                                         |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@zed-industries/claude-code-acp` is third-party; abandonment risk                      | We pin a known version. If the package goes unmaintained, fork it under `lib/backends/claude-acp/` (it's small — ~500 lines per the npm metadata). |
| Codex `app-server` is "experimental"; the protocol may change                           | Vendor the JSON schema (via `codex app-server generate-json-schema`) and test against it. Schema drift triggers a CI canary.                       |
| MCP aggregator namespace collisions (two servers register `read_file`)                  | All tools are presented as `<server>:<tool>` to clients; no implicit collision merge.                                                              |
| Long-running daemons leak memory or hang                                                | 5-min idle timeout, exponential-backoff restart on crash, max 5 restart attempts before marking dead. Operator can `kill` the daemon to recover.   |
| Some Anthropic policy restricts using `@zed-industries/claude-code-acp` for our purpose | Verify license + ToS before adoption. Apache-2.0 license suggests broad use is fine, but review.                                                   |
| Dependency-attack-surface growth                                                        | Each new dep is exact-pinned in package.json. `pnpm audit` runs in CI. SBOM (CycloneDX, already shipping) catches new transitive deps.             |
| ACP protocol drift in `@zed-industries/agent-client-protocol`                           | Pin to known minor version range; release notes monitored; conformance test against a captured Zed session catches behavior drift.                 |

## Estimated Effort

| Phase                                | Work                                                                                          | Effort      |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | ----------- |
| 0. Broker-aware gemini quick win     | Lift broker-probe out of plugin tree; dispatcher branch; tests                                | 1 day       |
| 1. ACP server + per-backend adapters | New bin + ACP server logic + 3 adapters + claude/codex translators + lifecycle/health         | 1.5-2 weeks |
| 2. MCP aggregation                   | Discovery + aggregator (use existing or vendor 300 lines) + tool routing + namespace handling | 3-5 days    |
| 3. Cross-cutting                     | Cost telemetry; auth (—auto-key); README + architecture docs                                  | 2-3 days    |

Total: ~3-4 weeks for one engineer.

## Validation

`openspec validate add-unified-acp-server-with-mcp-aggregation
--strict` SHALL pass. Spec deltas SHALL parse cleanly; every
Requirement SHALL have at least one Scenario; no Requirement SHALL be
missing SHALL/MUST language.

Phase 1 conformance: artagon-acp-server passes the ACP conformance
suite (`@zed-industries/agent-client-protocol`'s included tests, if
they ship them; else our own conformance suite mirroring the spec).

Phase 2 conformance: the MCP aggregator passes
`@modelcontextprotocol/sdk`'s included server tests for tools/list,
tools/call, resources/list, prompts/list, prompts/get.

End-to-end: a real Zed editor session driving each of the three
backends via artagon-acp-server, with at least one MCP tool call
that's hosted on a different backend than the one driving the
session.
