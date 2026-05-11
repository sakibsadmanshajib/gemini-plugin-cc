# Codex backend

> **Status (2026-05-11):** the warm-path transport in this backend is
> currently dead-code against upstream codex `0.130.0+`. The
> `codex acp` subcommand was removed upstream in favor of
> `codex app-server` — codex's own JSON-RPC 2.0 schema with
> `thread/turn/item` methods, NOT Zed's ACP wire format.
> `buildCodexArgs` still emits `["acp", ...]`, so calling
> `codexBackend.transports.cli().start()` against current codex falls
> through to the interactive TUI and fails framing. The slash-command
> hot path (`/codex:prompt`) is unaffected — it uses the stateless
> `runCodexExec` (`codex exec --json`) runner. The warm path returns
> once the `app-server` translator lands; see
> `openspec/changes/add-unified-acp-server-with-mcp-aggregation/`
> tasks T1.10 + T1.11.

The Codex backend (`lib/backends/codex.mjs`) is _declared_ to launch the
`codex` CLI in a long-running JSON-RPC subprocess. Per the project's
CLI-only architecture, there is no SDK or HTTP transport; all backends
speak the project's internal ACP shape through their CLI binary.

## Quick start

```js
import { codexBackend } from "#lib/backends/codex.mjs";
import { createAcpClient } from "#lib/acp/client.mjs";

const transport = codexBackend.transports.cli({
  cwd: process.cwd(),
  env: process.env,
  effort: "high", // codex-specific optimization knob
  model: "gpt-5-codex",
});

const client = createAcpClient(transport);
await client.start();
```

## Authentication

The Codex CLI manages auth — the plugin doesn't handle credentials directly.

1. **`codex login`** writes credentials to `~/.codex/auth.json`. This is
   the canonical path.
2. **`OPENAI_API_KEY`** env var — recognized by the CLI as a fallback.
3. **`-c` config overrides** (`codex -c api_key=...`) — supported but
   not surfaced through the backend factory; pass via `extraArgs` if
   needed.

If none resolves, the CLI rejects ACP requests; the backend's transport
surfaces the error as an `auth_required` health transition.

## Model aliases

```js
codexBackend.modelAliases.get("spark"); // "spark"  (default)
codexBackend.modelAliases.get("gpt-5"); // "gpt-5"
codexBackend.modelAliases.get("gpt-5-codex"); // "gpt-5-codex"
codexBackend.modelAliases.get("o3"); // "o3"
codexBackend.modelAliases.get("o3-mini"); // "o3-mini"
codexBackend.modelAliases.get("o4-mini"); // "o4-mini"
```

`resolveCodexModel(alias)` translates user-supplied aliases. Unknown
aliases pass through unchanged — same contract as `resolveGeminiModel`.

## CLI-specific optimization options

`buildCodexArgs(config)` is the pure argv builder, exported and tested
in `tests/unit/cli-args-builders.test.mjs`. Supported options on
`CodexBackendConfig`:

| Option      | Flag emitted       | Notes                                    |
| ----------- | ------------------ | ---------------------------------------- |
| `effort`    | `--effort <level>` | `low \| medium \| high \| max`           |
| `model`     | `--model <id>`     | Per-invocation model selection.          |
| `quiet`     | `--quiet`          | Suppress banner/version output.          |
| `extraArgs` | (verbatim, last)   | Pass-through for flags not yet declared. |
| `command`   | (binary path)      | Test seam — overrides `codex` default.   |

Note: codex does not expose `--effort` at the top-level help; it lives
on `codex exec` and certain subcommands. The backend builder emits it
unconditionally when set; if the running codex version doesn't accept
the flag, the subprocess will exit with an error (caught by the
transport's `worker_missing` health transition).

## Session handling

Once the `app-server` migration lands (Option A), session lifecycle is
owned in-band over JSON-RPC: clients issue `thread/new` (codex's
equivalent of `session/new`) and reference the resulting thread id on
subsequent `turn/start`/`turn/cancel` calls. The project's internal ACP
shape (`session/new`/`session/prompt`/`session/cancel`) is what the
`lib/translate/codex-app-server.mjs` translator will map onto codex's
schema in both directions.

For stateless one-shot operation today, callers use the
`runCodexExec` runner (`lib/runners/codex-exec.mjs`) which spawns
`codex exec --json <prompt>` per turn. The stateless path IS exposed
through the project — via `runStatelessTurn(BACKEND_NAMES.CODEX, ...)`
from `lib/runners/dispatch.mjs` — it's just not exposed through
`codexBackend.transports.cli` because that factory targets the
long-running server mode.

## Wire log

The CliTransport records every JSON-RPC frame to `ACP_WIRE_LOG` when set:

```sh
ACP_WIRE_LOG=/tmp/codex-wire.jsonl <slash command>
```

Line-delimited JSON consumable by `lib/test-utils/fixture-replayer.mjs`.

## Troubleshooting

**`codex: command not found`** — install via `npm install -g @openai/codex`.
Or pass an explicit path via `command: "/path/to/codex"`.

**Auth error on first request** — run `codex login`, or set
`OPENAI_API_KEY` in env, or pass `-c api_key=...` via `extraArgs`.

**`--effort: unknown flag`** — the running codex version doesn't accept
`--effort` on the chosen subcommand. The flag lives on `codex exec` and
certain other subcommands but not on every entry point. Drop the
option from `BackendConfig` (or upgrade codex). The CliTransport will
surface this as a child exit + a `worker_missing` health transition;
the AcpClient rejects pending requests so the failure is observable,
not silent.

**`codex acp` falls through to the interactive TUI** — the `acp`
subcommand was removed upstream as of codex 0.130.0+; only the
declared transport hits this path. The slash-command runners use
`codex exec` so they are not affected. The fix is the `app-server`
migration tracked in the openspec change above.

**Health stuck at `worker_missing` shortly after start** — the codex
child exited unexpectedly. Check stderr; the most common cause is an
auth misconfiguration that codex reports inline before exit.

## See also

- `docs/cli-options-research.md` — full CLI flag taxonomy across all backends.
- `docs/transport-cli.md` — CliTransport reference.
- `docs/architecture.md` — multi-backend layer diagram.
- `docs/backends/gemini.md`, `docs/backends/claude.md` — sibling references.
