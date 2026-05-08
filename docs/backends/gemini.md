# Gemini backend

The Gemini backend (`lib/backends/gemini.mjs`) delegates to Google's Gemini via the CLI's ACP (Agent Client Protocol) mode. Two transports:

- `cli` — spawn `gemini --acp` per session (default, simplest)
- `brokerSocket` — connect to an existing long-running broker via Unix socket

All three backends in this project use CLI adapters only (per the November 2026 CLI-only pivot — see `docs/architecture.md`). Gemini and Codex both speak ACP over their respective CLI binaries; Claude is declared but pending upstream ACP support. SDK and HTTP transports were removed.

## Quick start

```js
import { geminiBackend } from "../../lib/backends/gemini.mjs";
import { createAcpClient } from "../../lib/acp/client.mjs";

// Direct CLI transport
const transport = geminiBackend.transports.cli({
  cwd: process.cwd(),
  env: process.env,
});

const client = createAcpClient(transport);
await client.start();

const init = await client.request("initialize", {
  clientInfo: { name: "my-app" },
});
// init.authMethods → array of { id, name, description }
```

## Authentication

The Gemini CLI itself manages auth — the plugin does not handle credentials directly. Three resolution paths inside the CLI:

1. **`GEMINI_API_KEY`** env var — present? authenticated as `api_key`.
2. **`GOOGLE_API_KEY`** env var — present? authenticated as `google_api_key`.
3. **`GOOGLE_APPLICATION_CREDENTIALS`** — service-account JSON path; authenticated as `service_account`.
4. **OAuth via `gemini` CLI** — interactive `!gemini` (or `gemini login` depending on version) writes credentials the CLI reads on subsequent runs.

If none resolve, ACP `authenticate` requests fail and the runtime surfaces the failure as an auth error. `setupHints.authCommand` is `!gemini` (the user types this at the host shell).

## Model aliases

```js
geminiBackend.modelAliases.get("auto-gemini-3"); // "auto-gemini-3"  (auto-routing)
geminiBackend.modelAliases.get("auto-gemini-2.5"); // "auto-gemini-2.5"
geminiBackend.modelAliases.get("pro"); // "gemini-3.1-pro-preview"
geminiBackend.modelAliases.get("flash"); // "gemini-3-flash-preview"
geminiBackend.modelAliases.get("flash-lite"); // "gemini-3.1-flash-lite-preview"
```

Concrete model IDs (`gemini-3.1-pro-preview`, `gemini-3-flash-preview`, `gemini-2.5-pro`, etc. — full set in `lib/backends/gemini.mjs::MODEL_ALIASES`) pass through unchanged. Default is `auto-gemini-3` (CLI routes to the best available 3.x model).

## Transports

### `transports.cli(config)` — default

```js
const transport = geminiBackend.transports.cli({
  cwd: "/path/to/repo",
  env: { ...process.env, GEMINI_API_KEY: "..." },
});
```

Spawns `gemini --acp` as a subprocess; framing is newline-delimited JSON over stdio. SIGTERM-on-close with 5s grace then SIGKILL. Health states: queued → active → quiet (after 15s of silence) → completed/cancelled/worker_missing.

Use this for:

- Foreground commands where the session is one-shot (e.g., `/gemini:setup`, `/gemini:status`).
- Cases where the CLI binary is already on `PATH` and there's no broker running.

### `transports.brokerSocket(endpoint, config)` — broker-routed

```js
const session = loadBrokerSession(cwd);
if (session) {
  const transport = geminiBackend.transports.brokerSocket(session.endpoint, {
    cwd,
  });
  // ...
}
```

Connects to an existing broker over a Unix domain socket (Linux/macOS) or named pipe (Windows). The broker is a long-running daemon (`plugins/gemini/scripts/acp-broker.mjs`) that owns one `gemini --acp` child and multiplexes JSON-RPC across multiple client connections.

Use this for:

- Cross-cutting operations (e.g., `session/cancel` against a session owned by a different client) — a fresh subprocess wouldn't reach the live session.
- Multi-client multiplex when several plugin invocations share one CLI subprocess (lower memory, shared auth).

The broker process itself is started by the legacy runtime (`session-lifecycle-hook.mjs::SessionStart` triggers `ensureBrokerSession`). Discover the endpoint via `loadBrokerSession(cwd)` from `plugins/gemini/scripts/lib/broker-lifecycle.mjs`.

## Translator

Gemini's ACP wire surface is already in ACP shape — there's no translator analogous to Codex's or Claude's. Notifications arrive as `session/update` directly. The runtime's renderer (`plugins/gemini/scripts/lib/render.mjs`) handles display.

## Wire log

Both transports record JSON-RPC frames to `ACP_WIRE_LOG` when the env var is set:

```sh
ACP_WIRE_LOG=/tmp/gemini-wire.jsonl /gemini:review
```

Output is line-delimited JSON (`{"dir":"out","msg":...}`) directly consumable by `lib/test-utils/fixture-replayer.mjs::replayFixture`. Set `ACP_WIRE_LOG_RAW=1` to disable credential-field redaction (local debug only).

## Troubleshooting

**`gemini: command not found`** — install `@google/gemini-cli` globally: `npm install -g @google/gemini-cli`. Or pass an explicit path via `command: "/path/to/gemini"` in the transport config.

**Auth probe hangs on `authenticate`** — the real Gemini CLI's auth flow can hang indefinitely on machines with no network reach to Google's OAuth endpoints. CI uses a fake binary (`tests/mocks/gemini-mock.mjs`) to avoid this. For local debug, set `GEMINI_API_KEY` to a known-good key to short-circuit OAuth.

**`session/cancel` doesn't reach the running session** — verify you're using `transports.brokerSocket` (not `transports.cli`). A fresh subprocess can't cancel a session owned by a different process.

**Health stuck at `worker_missing` shortly after start** — the `gemini --acp` child exited unexpectedly. Check stderr for the underlying error; common causes are auth failure on OAuth machines and the CLI version being too old to support `--acp` (requires `@google/gemini-cli` ≥ 0.33 for some Gemini 3 features).

**Health stuck at `quiet` for several minutes** — the transport's quiet-after-15s threshold has fired but the child is still alive. This is informational, not an error; the runtime's renderer surfaces it as "model is taking longer than expected."

## See also

- `docs/transport-cli.md` — full CliTransport reference
- `docs/architecture.md` — multi-backend layer diagram
- `docs/backends/codex.md` — for comparison: Codex's SDK-first approach
- `docs/backends/claude.md` — for comparison: Claude's SDK-only approach
