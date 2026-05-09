# Design: add-unified-acp-server-with-mcp-aggregation

## Architectural shape

```
┌─────────────────────────────────────────────────────────────────────┐
│   ACP clients (Zed editor, future tools, our own artagon-agent)     │
└─────────────────────────────────────────────────────────────────────┘
                                  │  ACP JSON-RPC
                                  │  stdio:// | unix:// | ws://
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         artagon-acp-server                          │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ AgentSideConnection (@zed-industries/agent-client-protocol) │   │
│  └─────────────────────────┬───────────────────────────────────┘   │
│                            ▼                                        │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │ acp-backend-router  →  selects backend per session/prompt   │   │
│  └─────────────────────────┬───────────────────────────────────┘   │
│              ┌─────────────┼─────────────┐                          │
│              ▼             ▼             ▼                          │
│       ┌──────────┐  ┌──────────┐  ┌──────────┐                     │
│       │ claude-  │  │  codex-  │  │  gemini- │                     │
│       │ adapter  │  │  adapter │  │  adapter │                     │
│       └────┬─────┘  └─────┬────┘  └─────┬────┘                     │
│            │              │              │                          │
│            │ ACP          │ Codex JSON-  │ ACP (native)             │
│            │ pass-thru    │ RPC translated│                          │
│            ▼              ▼              ▼                          │
│       ┌──────────┐  ┌──────────────┐ ┌──────────┐                  │
│       │ claude-  │  │ codex        │ │ gemini   │                  │
│       │ code-acp │  │ app-server   │ │ --acp    │                  │
│       │ (npm)    │  │ (subprocess) │ │ (subproc)│                  │
│       └──────────┘  └──────────────┘ └──────────┘                  │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │            MCP aggregator (lib/server/mcp-aggregator)       │   │
│  │                                                             │   │
│  │   tools/list = ⋃  (each backend's MCP servers' tools)      │   │
│  │                  with ns prefix <server>:<tool>             │   │
│  │   tools/call: routed by ns prefix to host MCP server        │   │
│  └────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                  Per-backend MCP servers (already configured
                  in ~/.claude, ~/.codex, ~/.gemini settings)
```

## Why this shape

The system has been growing a "consumer" architecture (artagon
spawns CLIs, dispatches turns) when it could be growing a "broker"
architecture (artagon hosts the multiplexed view; clients connect
to it). Three CLIs already act as servers in their own right:
gemini natively (`--acp`), codex experimentally (`app-server`),
claude via a published adapter (`@zed-industries/claude-code-acp`).
Composing those into one ACP-shaped surface costs less than
maintaining three separate consumer integrations long-term.

The architectural inversion also unlocks integrations we couldn't
otherwise have: any ACP client (Zed today; future tools tomorrow)
gets all three backends through one connection, and MCP tools
registered with one backend become callable from the others.

## Component contracts

### `lib/server/acp-server.mjs`

```js
/**
 * @typedef {{
 *   listen: "stdio" | { unix: string } | { ws: { host: string, port: number } },
 *   defaultBackend?: "claude" | "codex" | "gemini",
 *   apiKey?: string | string[],         // ACP-level bearer auth
 *   idleMs?: number,                    // per-backend idle timeout
 *   mcpAggregation?: boolean,           // default: true
 * }} AcpServerOptions
 */

export function createAcpServer(options) {
  return {
    /** Promise<{ host?: string, port?: number, transport: "stdio" | "unix" | "ws" }> */
    listen() {
      /* ... */
    },
    /** Promise<void> */
    close() {
      /* ... */
    },
  };
}
```

The implementation creates an `AgentSideConnection` from
`@zed-industries/agent-client-protocol`, wires its handlers to
the router. ACP method coverage (per spec):

| ACP method                     | Handling                                |
| ------------------------------ | --------------------------------------- |
| `initialize`                   | Returns capabilities (what we support)  |
| `authenticate`                 | If `apiKey` set, validate bearer        |
| `session/new`                  | Allocate a sessionId in our state       |
| `session/load`                 | Resume from disk if present             |
| `session/prompt`               | Route to backend; stream session/update |
| `session/cancel`               | Forward cancel to active backend        |
| `tools/list`, `tools/call` etc | MCP aggregator handles                  |

### `lib/server/acp-backend-router.mjs`

Decides which backend handles a given session/prompt. Order:

1. **Explicit hint on the prompt** (`{ model: "claude-sonnet-4-6", ... }`)
   resolved through the existing `lib/backends/*/aliases.mjs`.
2. **Per-session sticky binding** (once a session picks a backend,
   subsequent turns go to the same backend unless re-bound).
3. **Default** from `--backend` flag or `ARTAGON_ACP_BACKEND` env.

### `lib/server/acp-backend-adapter.mjs`

Three implementations, each with the same external shape:

```js
/**
 * @typedef {{
 *   start(): Promise<void>,
 *   prompt(opts: PromptOptions): AsyncIterator<SessionUpdate>,
 *   cancel(sessionId: string): Promise<void>,
 *   close(): Promise<void>,
 *   health(): "starting" | "healthy" | "degraded" | "restarting" | "dead"
 * }} BackendAdapter
 */
```

#### `geminiBackendAdapter`

- Spawns `gemini --acp` once.
- Uses our existing `lib/transport/cli.mjs` and `lib/acp/client.mjs`.
- Pass-through: incoming ACP `session/prompt` becomes outgoing ACP
  `session/prompt` to the child.

#### `codexBackendAdapter`

- Spawns `codex app-server` once with stdio transport.
- Uses `vscode-jsonrpc` (or `@zed-industries/agent-client-protocol`'s
  framing) for JSON-RPC over the child's stdio.
- Translates each direction:
  - **Incoming** (our ACP) → **outgoing** (Codex app-server JSON-
    RPC): `session/prompt` → `newConversation` + `sendUserMessage`
    (per Codex's `ClientRequest.json` schema).
  - **Incoming** (Codex events) → **outgoing** (our ACP
    `session/update`): assistant messages, tool calls, reasoning,
    etc. Implemented in `lib/translate/codex-app-server.mjs`.
- The Codex schema is vendored (via `codex app-server
generate-json-schema --out lib/backends/codex/app-server-schema/`)
  and pinned to a known codex version. CI canary regenerates and
  diffs.

#### `claudeBackendAdapter`

- Delegates entirely to `@zed-industries/claude-code-acp`. We
  spawn it as a child via stdio and pass ACP messages through.
- We don't reinvent the claude-as-ACP wrapper; we depend on the
  published one. Pin to exact version.
- If the package is abandoned, fork it (it's ~500 lines per its
  npm metadata).

### `lib/server/mcp-aggregator.mjs`

Discovers MCP servers from per-backend config:

| Backend | Config path                              | Format   |
| ------- | ---------------------------------------- | -------- |
| claude  | `~/.claude/settings.json` `mcpServers`   | JSON map |
| codex   | `~/.codex/config.toml` `[mcp_servers.*]` | TOML     |
| gemini  | `~/.gemini/settings.json` `mcpServers`   | JSON map |

Each unique MCP server URL/command is **spawned (or connected to)
once** via `@modelcontextprotocol/sdk`'s `Client` class. Tools,
resources, and prompts from each are aggregated:

- Tools: `<server>:<tool>` namespacing — no implicit collision merge
- Resources: same namespacing
- Prompts: same namespacing

When the ACP server receives `tools/call` with name `<srv>:<tool>`,
the aggregator routes the call to the MCP `Client` for `<srv>`.

The aggregator implementation choice (use existing `mcp-proxy-server`
vs. vendor 300 lines) is a Phase 2 decision. Both options:

- **Use existing**: faster to ship, but adds a dep and depends on
  an upstream we don't control. Evaluate adamwattis/mcp-proxy-server
  for code quality + maintenance + license.
- **Vendor 300 lines**: small, owned, no extra dep. The
  `@modelcontextprotocol/sdk` already provides Client and Server
  primitives; the aggregator is just a routing table on top. ~300
  lines of well-typed code based on existing examples.

Recommendation: vendor. Decision documented in tasks.md T2.3.

### `lib/translate/codex-app-server.mjs`

Codex `app-server`'s schema (vendored under `lib/backends/codex/app-
server-schema/`) defines messages like:

- `ClientRequest` discriminated union: `newConversation`, `sendUserMessage`,
  `getConversationsList`, `archiveConversation`, etc.
- `ClientNotification`: `conversationUpdated`, `streamChunk`, etc.
- Per-turn lifecycle: `newConversation` → `sendUserMessage` → many
  `streamChunk` notifications → final `responseFinished`.

Translation to ACP shape:

| Codex method                      | ACP shape                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| `newConversation` (response)      | `session/new` (response)                                     |
| `sendUserMessage` (request)       | `session/prompt` (request)                                   |
| `streamChunk` (notification)      | `session/update.update.session_update`: agent_message_chunk  |
| `applyPatchApproval` (request)    | `session/update.update.session_update`: tool_call (approval) |
| `responseFinished` (notification) | `session/update.update.session_update`: turn_completed       |
| `chatgptAuthTokensRefresh` (req)  | Hidden from upstream ACP                                     |

Tested with golden fixtures captured from a real `codex app-server`
session. Run on each `codex` version bump.

### `bin/artagon-acp-server.mjs`

Same structure as `bin/artagon-openai-server.mjs`:

- commander argv parser
- `--listen <stdio|unix://path|ws://host:port>` (default: stdio)
- `--api-key`, `--api-key-file`, `--auto-key`, `--auto-key-rotate`,
  `--auto-key-store` — same as openai-server
- `--backend <name>` default backend when prompt has no model hint
- `--mcp-aggregation <on|off>` default on
- SIGINT/SIGTERM graceful shutdown

## Persistence + state

### `$XDG_STATE_HOME/artagon-agent-cli-plugin/`

| Path                            | Mode  | Purpose                        |
| ------------------------------- | ----- | ------------------------------ |
| `cost.jsonl`                    | 0o600 | Per-turn cost log (existing)   |
| `api-key`                       | 0o600 | Auto-key file store (existing) |
| `acp-server.json`               | 0o600 | Server endpoint manifest (NEW) |
| `acp-sessions/<sessionId>.json` | 0o600 | Per-session state (NEW)        |
| `acp-pids/<backend>.pid`        | 0o644 | Backend daemon pid (NEW)       |

### Endpoint manifest (`acp-server.json`)

```json
{
  "transport": "unix",
  "address": "/var/folders/.../artagon-acp.sock",
  "pid": 12345,
  "startedAt": "2026-05-09T...",
  "autoKey": {
    "store": "keychain",
    "retrieveCommand": "security find-generic-password -a $USER -s artagon-agent-cli-plugin -w"
  },
  "backends": ["gemini", "codex", "claude"]
}
```

Written on listen, deleted on close. ACP clients (or
`artagon-agent --via-acp`) read it to find the running server.

## Test plan

### Unit

- `acp-backend-router`: model-hint resolution for each backend's
  aliases; per-session sticky binding; default fallback.
- `acp-backend-adapter` (mocked children): start/restart/idle-
  timeout/health labels.
- `mcp-aggregator`: namespace handling; tool routing; collision
  detection.
- `lib/translate/codex-app-server`: each Codex method → ACP shape
  via golden fixtures.

### Integration

- Spawn artagon-acp-server in a child process, drive it from
  `@zed-industries/agent-client-protocol`'s ClientSideConnection,
  send a real prompt to each of three backends.
- MCP cross-backend: register a fake MCP server in claude's config,
  invoke its tool through a session bound to gemini, verify the
  call lands.
- Crash recovery: kill a backend daemon mid-session, verify next
  turn restarts cleanly.
- Auth: `--auto-key` set; ACP request without bearer token
  rejected.

### Conformance

- ACP conformance suite (from `@zed-industries/agent-client-
protocol` if they ship one; else mirror the spec).
- MCP conformance suite (from `@modelcontextprotocol/sdk`'s
  included server tests).

### End-to-end (manual, recorded)

- Real Zed editor connecting via ACP.
- Each backend selectable.
- One real MCP tool call from a session bound to a different backend.
- Wire-log captured to fixtures for regression.

## Open questions

1. **MCP aggregator: use existing or vendor?** Recommendation:
   vendor 300 lines using `@modelcontextprotocol/sdk` primitives.
   Documented as T2.3 in tasks.md; decision pending evaluation of
   `mcp-proxy-server`'s code quality and maintenance.

2. **Claude adapter: depend on `@zed-industries/claude-code-acp` or
   fork?** Recommendation: depend, with fork-readiness (the package
   is small enough to vendor if needed).

3. **Codex app-server schema versioning**: how do we react when
   codex bumps the schema? Recommendation: CI canary regenerates
   schema; drift fails CI; an issue is filed; the translator may
   need updates. Schema major bumps may require gating behind a
   `--codex-schema-version` flag.

4. **Cross-backend tool calls and security**: a tool registered with
   one backend becomes callable from sessions bound to others. Does
   the operator want this on by default or opt-in per tool? Default:
   on, with a deny-list at
   `$XDG_CONFIG_HOME/artagon-agent-cli-plugin/mcp-allowlist.json`.
