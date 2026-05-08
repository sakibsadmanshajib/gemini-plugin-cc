# CliTransport

`lib/transport/cli.mjs::createCliTransport(options)` returns a `ClientTransport`-conformant object that drives a CLI subprocess speaking newline-delimited JSON-RPC over stdio.

## When to use it

Most ACP backends today ship as a CLI binary that exposes a JSON-RPC server when invoked with a specific subcommand:

- Gemini: `gemini --acp`
- Codex: `codex app-server`
- Future backends: `<backend> --acp` or equivalent

CliTransport is the only client-side ACP transport in the project. Per the
CLI-only architecture (see `docs/architecture.md` and the November 2026
pivot), in-process SDK transports and long-running HTTP/SSE app-server
transports were removed in favor of a uniform CLI surface across all
backends. `BrokerSocketTransport` exists as a sibling for cross-cutting
operations against an already-running broker (e.g. cancellation), but
is built on the same line-framing the CLI subprocess uses.

## API

```js
import { createCliTransport } from "../lib/transport/cli.mjs";
import { createAcpClient } from "../lib/acp/client.mjs";

const transport = createCliTransport({
  command: "gemini",
  args: ["--acp"],
  env: { ...process.env, GEMINI_API_KEY: "..." },
  cwd: workspaceRoot,
  quietAfterMs: 15000, // optional; transition to "quiet" after silence
});

const client = createAcpClient(transport);
await client.start();

const session = await client.request("session/new", {
  cwd: workspaceRoot,
  mcpServers: [],
});
client.notify("session/cancel", { sessionId: session.sessionId });

await client.close();
```

## Lifecycle

| Method                    | Behavior                                                                                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start()`                 | Spawns `command` with `args`. Wires `stdout` line-buffer → `onMessage`. Wires `stderr` to parent stderr (prefixed with `[<command> stderr]`). Resolves once stdio is wired (does not wait for handshake). Idempotent. |
| `send(message)`           | Frames the JSON-RPC message and writes to child stdin. Records in wire log if `ACP_WIRE_LOG` is set. Throws if stdin is unavailable.                                                                                  |
| `onMessage(handler)`      | Registers a handler for parsed inbound JSON-RPC frames. Multiple handlers are fan-out.                                                                                                                                |
| `onHealthChange(handler)` | Registers a health-transition observer.                                                                                                                                                                               |
| `healthState()`           | Current `HealthState` (see below).                                                                                                                                                                                    |
| `close()`                 | Sends SIGTERM, waits up to 5000ms (`SHUTDOWN_GRACE_MS`), then SIGKILL. Idempotent.                                                                                                                                    |
| `isOpen()`                | True iff started, not closing, child still alive.                                                                                                                                                                     |

## Health states

CliTransport drives the following transitions through `HealthState`:

| State            | When                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| `queued`         | Created but `start()` not yet called                                     |
| `active`         | Running, recent activity within `quietAfterMs`                           |
| `quiet`          | Running, no inbound or outbound message for `quietAfterMs` (default 15s) |
| `worker_missing` | Child exited unexpectedly (without a prior `close()` call)               |
| `completed`      | Child exited cleanly after `close()`                                     |
| `cancelled`      | Child exited non-zero after `close()`                                    |

The conformance suite at `lib/test-utils/conformance.mjs` verifies the start → active and close → terminal-state transitions. Custom backends extending CliTransport (e.g., a backend with rate-limit-aware health) layer additional states by intercepting `onMessage` and calling `setHealth` from a wrapper.

## Wire log integration

If `ACP_WIRE_LOG=/path/to/wire.jsonl` is set in the environment, every frame CliTransport sends or receives is appended to the file as `{"dir":"out","msg":...}` / `{"dir":"in","msg":...}`. The format is identical to `tests/integration/fixtures/*.jsonl` so the captured wire log can be replayed via `lib/test-utils/fixture-replayer.mjs::replayFixture` for regression testing.

`ACP_WIRE_LOG_RAW=1` disables credential-field redaction (api_key, authorization, token, password) — for local debug only; do not commit raw wire logs.

## Stderr discipline

CliTransport never writes to its parent's stdout. Child stderr is prefixed with `[<command> stderr]` and forwarded to `process.stderr`. This preserves the broker pattern: stdout is the JSON-RPC wire (when this transport is itself driven by a broker process); logs route to stderr. The `Stdio Discipline` requirement in `gemini-plugin-baseline` pins the wider component-level discipline.

## Differences from the legacy `acp-client.mjs`

| Legacy `plugins/gemini/scripts/lib/acp-client.mjs`            | New `lib/transport/cli.mjs`                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| Gemini-specific (hardcodes `gemini --acp`)                    | Backend-agnostic (parameterized)                              |
| Built-in broker fallback (broker socket → direct)             | No broker awareness; broker is a separate transport           |
| Couples ACP request/response logic with subprocess management | Pure transport; ACP correlation lives in `lib/acp/client.mjs` |
| Direct `acp-protocol.d.ts` import for typedefs                | Generic `lib/acp/types.mjs` shapes                            |

The legacy client stays in production today (driving `gemini-plugin-baseline`) and will be retired in `add-transport-abstraction-with-gemini` T7 (runtime swap).
