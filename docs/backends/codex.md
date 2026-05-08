# Codex backend

The Codex backend (`lib/backends/codex.mjs`) launches the `codex` CLI in
ACP mode (`codex acp`) — a long-running JSON-RPC subprocess. Per the
project's CLI-only architecture, there is no SDK or HTTP transport; all
backends speak ACP through their CLI binary.

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
3. **`-c` config overrides** (`codex acp -c api_key=...`) — supported but
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

Codex's ACP mode owns session lifecycle in-band over JSON-RPC: callers
issue `session/new` to create a session and receive a `sessionId`,
then reference it on subsequent `session/load`/`session/prompt`/
`session/cancel` calls. There is no spawn-time `--session-id` flag —
that's a Claude-only feature; see `docs/cli-options-research.md` for
the cross-backend session-management table.

For non-ACP (stateless) operation, callers spawn `codex exec <prompt>`
directly via `Bash`; that path is not exposed through this backend
because the runtime always uses ACP for streaming.

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
`--effort` on `acp`. Drop the option from `BackendConfig` (or upgrade
codex). The CliTransport will surface this as a child exit + a
`worker_missing` health transition; the AcpClient rejects pending
requests so the failure is observable, not silent.

**Health stuck at `worker_missing` shortly after start** — the codex
child exited unexpectedly. Check stderr; the most common cause is an
auth misconfiguration that codex reports inline before exit.

## See also

- `docs/cli-options-research.md` — full CLI flag taxonomy across all backends.
- `docs/transport-cli.md` — CliTransport reference.
- `docs/architecture.md` — multi-backend layer diagram.
- `docs/backends/gemini.md`, `docs/backends/claude.md` — sibling references.
