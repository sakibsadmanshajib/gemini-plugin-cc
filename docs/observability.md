# Observability

The runtime ships three observability surfaces, all opt-in via env vars
so production deployments pay zero cost when nothing's enabled. Each is
documented here with its env contract, output format, and the failure
mode if the underlying machinery is misconfigured.

## Layered shape

```
┌─────────────────────────────────────────────────────────────┐
│  Logger          lib/logger.mjs                              │
│  - pino-based structured logger                              │
│  - stderr-only (stdout is reserved for the JSON-RPC wire)    │
│  - redaction-first (known credential paths scrubbed)         │
│  - LOG_LEVEL=trace|debug|info|warn|error|fatal               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Wire log        lib/wire-log.mjs                            │
│  - JSONL capture of every JSON-RPC frame in/out              │
│  - format matches lib/test-utils/fixture-replayer.mjs        │
│  - ACP_WIRE_LOG=/path.jsonl (no-op singleton when unset)     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Tracing         lib/tracing.mjs                             │
│  - OpenTelemetry, lazy-loaded via dynamic import             │
│  - OTEL_EXPORTER_OTLP_ENDPOINT activates the SDK             │
│  - trace context on ACP via `_otel.traceparent` extension    │
└─────────────────────────────────────────────────────────────┘
```

## Logger

`logger` is a pino instance. Output goes to **stderr only** — stdout is
reserved for the JSON-RPC wire (the `Stdio Discipline` requirement in
`openspec/specs/gemini-plugin-baseline/spec.md` pins this per-component).

### Usage

```js
import { logger } from "#lib/logger.mjs";

logger.info({ jobId, sessionId }, "starting prompt");
logger.warn({ err }, "broker connect failed; falling back to direct CLI");

// Scope a child logger for a subsystem.
const brokerLog = logger.child({ component: "broker" });
brokerLog.error({ pid }, "child exited unexpectedly");
```

### Env vars

| Var            | Effect                                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`    | Sets minimum level. Default `info`. Values per pino convention.                                             |
| `LOG_PRETTY=1` | Human-readable output via `pino-pretty`. Local dev only — slows logging substantially. Disabled in CI/prod. |

### Redaction

The root logger has a `redact` config covering known credential paths
(`*.api_key`, `*.apiKey`, `*.token`, `*.authorization`, `*.password`,
`*.secret`, `*.bearer`, plus a few framework-specific paths). Values
become the literal string `"[REDACTED]"`.

**Opt-out for local debugging:** pass `{ rawAuth: 1 }` as a child binding.
The redaction skips that scope. **Never** ship `rawAuth` to production.

```js
const debugLog = logger.child({ rawAuth: 1, component: "auth-debug" });
// Now api_key etc. log raw — for local triage only.
```

### Failure mode

Pino is in-process and synchronous-by-default for stderr. Logger failures
are essentially "stderr is closed" which means the process is shutting
down anyway — no special handling needed.

## Wire log

When `ACP_WIRE_LOG=/path/to.jsonl` is set, every JSON-RPC frame the
runtime sends or receives is appended as a tagged line to that file.

### Format

One record per line:

```json
{"dir": "out", "msg": {"jsonrpc": "2.0", "id": 1, "method": "initialize", ...}}
{"dir": "in",  "msg": {"jsonrpc": "2.0", "id": 1, "result": {...}}}
{"dir": "in",  "msg": {"jsonrpc": "2.0", "method": "session/update", "params": {...}}}
```

This format is **identical** to `tests/integration/fixtures/*.jsonl`. The
same file produced in production can be replayed in tests via
`lib/test-utils/fixture-replayer.mjs::replayFixture()` — capture a real
session, replay it in a unit test.

### Env vars

| Var                | Effect                                                              |
| ------------------ | ------------------------------------------------------------------- |
| `ACP_WIRE_LOG`     | Path to write JSONL frames. Unset → no-op singleton, zero overhead. |
| `ACP_WIRE_LOG_RAW` | Disable credential-field redaction in wire log. Local debug only.   |

### Redaction

Wire log applies the same field-path redaction as the logger by default.
Set `ACP_WIRE_LOG_RAW=1` to disable; useful when triaging an auth path
and you need to see what's actually on the wire. **Never set in
production** — the wire log file becomes a credential leak.

### Failure mode

`openWireLog()` opens an append stream. If the path is unwritable
(permissions, disk full), the open fails and the runtime emits a single
warning to stderr then continues with a no-op wire log. ACP traffic is
never blocked on wire-log writes — the file is best-effort observability.

## Tracing

OpenTelemetry SDK + exporter, **lazy-loaded** via dynamic import. The
SDK is ~150KB and starts a background exporter; lazy-load means a user
who never sets `OTEL_EXPORTER_OTLP_ENDPOINT` pays zero cost.

### Activation

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_SERVICE_NAME=gemini-plugin \
<your slash command>
```

Defaults assume Jaeger / Tempo / any OTLP-HTTP endpoint at `:4318`.
Without `OTEL_EXPORTER_OTLP_ENDPOINT`, `getTracer()` returns a no-op
implementation that records nothing.

### Usage

```js
import { getTracer } from "#lib/tracing.mjs";

async function runPrompt() {
  const tracer = await getTracer();
  await tracer.startActiveSpan("session/prompt", async (span) => {
    span.setAttribute("backend", "gemini");
    span.setAttribute("model", model);
    try {
      return await client.request("session/prompt", { prompt });
    } finally {
      span.end();
    }
  });
}
```

For sync paths that can't await tracer init: `getTracerSyncOrNoop()`
returns the cached tracer or a no-op fallback. First call after
activation may miss the span; subsequent calls get the real tracer.

### ACP context propagation

Trace context propagates via a non-standard `_otel.traceparent` extension
field on outbound ACP messages. Backend CLIs ignore unknown fields per
JSON-RPC convention, so propagation is non-breaking — but spans
**terminate at the subprocess boundary** unless the backend implements
its own propagation. Today, none of `gemini`, `codex`, or `claude` does.

This means: end-to-end traces span the runtime layer (transport →
client → middleware → backend factory) but stop where the JSON-RPC
crosses into the CLI binary. That's a known limitation; see
`add-testing-and-observability` proposal.

### Env vars

| Var                           | Effect                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Activates the SDK. Without it, tracing is a no-op throughout.                                                                |
| `OTEL_SERVICE_NAME`           | Service identity in spans. Default `gemini-plugin-cc`.                                                                       |
| `OTEL_RESOURCE_ATTRIBUTES`    | Standard OTel resource attribute string (`key=val,key=val`).                                                                 |
| `OTEL_TRACES_SAMPLER`         | Standard OTel sampler (`always_on`, `always_off`, `parentbased_traceidratio`, etc.). Default sampling per OTel SDK defaults. |

### Failure mode

Tracer init is best-effort. If the OTel SDK fails to load or the
exporter rejects the endpoint, `getTracer()` resolves to a no-op
implementation. Slash commands never fail because of tracing.

## Combining all three

A typical production-investigation session:

```sh
LOG_LEVEL=debug \
ACP_WIRE_LOG=/tmp/wire-2026-05-08.jsonl \
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.internal:4318 \
OTEL_SERVICE_NAME=gemini-plugin-staging \
/gemini:review
```

- Logger emits structured JSON to stderr at debug level.
- Wire log captures every frame for offline replay.
- Spans land in your OTLP collector for cross-cutting timing analysis.

All three are independent — enabling tracing doesn't enable wire log,
and disabling logger doesn't disable tracing. Mix as needed.

## Cost log

A fourth observability surface specific to the multi-backend runners:
each completed turn appends one JSONL row to a cost log under
`$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl` (or
`$ARTAGON_COST_LOG` override).

Schema:

```jsonc
{
  "timestamp":   "2026-05-08T19:00:00.000Z",
  "backend":     "claude" | "codex" | "gemini",
  "model":       "claude-sonnet-4-6" | "gpt-5-codex" | null,  // when CLI emits it
  "promptChars": 42,
  "usage":       { "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150 },
  "durationMs":  1234,
  "reason":      "stop" | "end_turn" | "error_max_turns" | null,
  "ok":          true
}
```

The log is append-only and race-safe across concurrent runners (no
shared registry; one process appends one line). Best-effort — failures
to write warn once on stderr and silently proceed; cost recording
must never block a turn.

### Surfaces

- **`bin/artagon-stats`** — shell-side aggregator. Prints global +
  per-backend totals, time window, and the N most recent turns.
  `--json` for tooling.
- **`/<plugin>:stats`** — host-side slash command (Claude Code / Codex
  CLI / Gemini host); same data via `lib/cost/aggregate.mjs` directly.
- **`/<plugin>:budget`** — token or USD budget vs. used. `--limit` for
  token budget; `--limit-usd` for dollar budget. `$ARTAGON_BUDGET_TOKENS`
  / `$ARTAGON_BUDGET_USD` env counterparts. Always exit 0; downstream
  gating reads `--json`.

### USD pricing layer

`lib/cost/pricing.mjs` translates tokens → USD using a per-backend +
per-model rate table (Sonnet/Opus/Haiku, GPT-5/o-series, Gemini Pro/
Flash). The recorded `model` field unlocks per-model rates; missing
model falls back to the per-backend default (Sonnet, GPT-5, Pro).

Override the rate table at runtime via `$ARTAGON_PRICING_OVERRIDE`
(JSON) — useful when vendor pricing changes between releases.

## See also

- `docs/architecture.md` — where these surfaces fit in the layered
  diagram.
- `docs/test-fixtures.md` — wire log → fixture replay loop.
- `lib/middleware/audit.mjs` — separate concern (per-session JSONL
  audit log written to `~/.acp-plugins/audit/<sessionId>/audit.jsonl`,
  always on; no env-gating).
- `lib/cost/{recorder,aggregate,pricing}.mjs` — cost log producer +
  reader + dollar estimation.
- `openspec/changes/add-testing-and-observability/proposal.md` —
  origin proposal for this layer.
