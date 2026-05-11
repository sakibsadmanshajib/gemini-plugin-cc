# Claude backend

> **Streaming status (2026-05-11):** Claude has a live warm-path
> streaming runner via `@agentclientprotocol/claude-agent-acp` (Zed's
> ACP wrapper around the Claude Agent SDK), enabled with
> `useStreaming: true` / `ARTAGON_STREAMING=1`. The
> `claudeBackend.transports.cli` declaration in `lib/backends/claude.mjs`
> is still parked because Anthropic's `claude` CLI has no `acp`
> subcommand — that direct path will land if/when upstream ships it.
> See `lib/runners/streaming/claude-streaming.mjs` and the **Streaming
> mode** section below.

## Streaming mode (warm path)

The streaming runner spawns `@agentclientprotocol/claude-agent-acp`
(bundled as a dependency) and drives it over standard Zed ACP
(`initialize`, `session/new`, `session/prompt`, `session/update`). It
behaves like `gemini-streaming.mjs` from the caller's perspective —
the supervisor manages start / idle reap / restart; the dispatcher
opts in via `useStreaming: true` or `ARTAGON_STREAMING=1`.

Cost records emit `transport: "claude-agent-acp"` (distinct from
gemini's `"acp-server"`) so per-backend warm-path latency stays
separable in `bin/artagon-stats.mjs` aggregations.

### Auth divergence — important

The streaming runner does NOT use the `claude` CLI's auth state. It
inherits whatever credentials the `@anthropic-ai/claude-agent-sdk`
finds at startup:

| Source                                             | Works with streaming runner?                      |
| -------------------------------------------------- | ------------------------------------------------- |
| `ANTHROPIC_API_KEY` env var                        | ✓ (Anthropic Console billing)                     |
| `claude login` (Claude Pro/Max OAuth)              | ✓ (the agent SDK reuses these creds when present) |
| Custom gateway via `auth._meta.gateway` capability | ✓ (advanced)                                      |

If neither is configured, `session/new` errors out at start time with
an actionable message and the dispatcher falls back to the cold-start
`runClaudePrint` path automatically. Operators who only want the CLI
path can opt out with `disableStreaming: true` or omit
`ARTAGON_STREAMING=1`.

### Tool surface divergence

`claude-agent-acp` uses the **Claude Agent SDK's** tool implementations
(Read, Write, Bash, etc., as defined by the SDK). These overlap with —
but are not identical to — the `claude` CLI's tools. If a slash
command depends on a specific CLI-only tool, route it through the
stateless `runClaudePrint` path instead.

## Stateless (cold-start) path

The Claude backend (`lib/backends/claude.mjs`) is also declared for
parity with Gemini and Codex but its **`transports.cli` is not yet
callable** — Anthropic's `claude` CLI does not currently support ACP
mode. Calling `transports.cli({...}).start()` throws an actionable
error:

> `Claude CLI does not yet support ACP mode. The Claude backend is declared for parity with codex/gemini but is not callable until upstream ships ACP support.`

The infrastructure is built so the swap is one-line when ACP arrives:
replace `createNotYetSupportedTransport` with `createCliTransport({ command: "claude", args: buildClaudeArgs(config), ... })`.

Slash commands today still go through the stateless `runClaudePrint`
runner (`claude --print --output-format=stream-json --verbose`) when
streaming is not enabled.

## Why declare a non-functional backend?

1. **Multi-backend parity** — the runtime's dispatcher iterates backends
   uniformly; having `claudeBackend` declared keeps that loop simple.
2. **CLI flag taxonomy is research-derived and tested** — `buildClaudeArgs`
   captures the full `claude --help` flag surface (per
   `docs/cli-options-research.md`) and is pinned by the
   `tests/unit/claude-args-builder.test.mjs` suite covering operation
   modes, session identity, model + cost, permission + tool surface,
   I/O format, and the no-silent-fallback validations below. When ACP
   arrives, no argv work needs to happen.
3. **Failures are loud** — calling the transport throws synchronously
   on `start()`, not silently after a hung handshake.

## buildClaudeArgs

`buildClaudeArgs(config)` is the pure argv builder, exported and tested
in `tests/unit/claude-args-builder.test.mjs`. It implements every flag
inventoried in `docs/cli-options-research.md`:

### Operation modes (mutually exclusive subset)

| Option     | Flag emitted      | Notes                                             |
| ---------- | ----------------- | ------------------------------------------------- |
| `print`    | `--print`         | Stateless one-shot. Required for non-text output. |
| `continue` | `--continue`      | Most recent conversation in cwd.                  |
| `resume`   | `--resume [<id>]` | `true` → picker; string → specific session id.    |

`continue` and `resume` are mutually exclusive (the builder throws).

### Session identity

| Option                 | Flag emitted               | Notes                                               |
| ---------------------- | -------------------------- | --------------------------------------------------- |
| `sessionId`            | `--session-id <uuid>`      | **Unique to Claude:** spawn-time session id.        |
| `forkSession`          | `--fork-session`           | When resuming, fork into a new id instead of reuse. |
| `noSessionPersistence` | `--no-session-persistence` | Disable saving (requires `print: true`).            |

### Model + cost

| Option          | Flag emitted             | Notes                                                          |
| --------------- | ------------------------ | -------------------------------------------------------------- |
| `model`         | `--model <id>`           | `sonnet`/`opus`/`haiku` aliases or full ids.                   |
| `fallbackModel` | `--fallback-model <id>`  | Auto-fallback on overload (requires `print: true`).            |
| `effort`        | `--effort <level>`       | `low \| medium \| high \| xhigh \| max` (Claude-unique tiers). |
| `maxBudgetUsd`  | `--max-budget-usd <amt>` | Cap spend (requires `print: true`).                            |

### Permission + tool surface

| Option            | Flag emitted               | Notes                                             |
| ----------------- | -------------------------- | ------------------------------------------------- |
| `permissionMode`  | `--permission-mode <m>`    | 6 modes incl. `acceptEdits`, `bypassPermissions`. |
| `allowedTools`    | `--allowedTools <t...>`    | Empty array dropped; never emits empty flag.      |
| `disallowedTools` | `--disallowedTools <t...>` | Same convention.                                  |

### I/O format

| Option                   | Flag emitted                 | Notes                                  |
| ------------------------ | ---------------------------- | -------------------------------------- |
| `outputFormat`           | `--output-format <f>`        | Non-text values require `print: true`. |
| `inputFormat`            | `--input-format <f>`         | Requires `print: true`.                |
| `includePartialMessages` | `--include-partial-messages` | Requires `print: true`.                |
| `includeHookEvents`      | `--include-hook-events`      | Requires `print: true`.                |

### Misc

| Option               | Flag emitted                 |
| -------------------- | ---------------------------- |
| `bare`               | `--bare`                     |
| `name`               | `--name <display>`           |
| `addDir`             | `--add-dir <dirs...>`        |
| `systemPrompt`       | `--system-prompt <p>`        |
| `appendSystemPrompt` | `--append-system-prompt <p>` |
| `extraArgs`          | (verbatim, last)             |

### Validation: no silent fallbacks

`buildClaudeArgs` THROWS on:

- Any `print`-only flag set without `print: true`. Multi-violation case
  names every offending field in one message.
- `continue` AND `resume` both set.

This matches the project's no-silent-fallbacks posture from
`lib/middleware/`. The thrown error is the spec — see the test file for
exact strings.

## Model aliases

```js
claudeBackend.modelAliases.get("sonnet"); // "claude-sonnet-4-6"
claudeBackend.modelAliases.get("opus"); // "claude-opus-4-7"
claudeBackend.modelAliases.get("haiku"); // "claude-haiku-4-5"
```

Concrete ids (`claude-sonnet-4-6`, etc.) pass through unchanged.
`resolveClaudeModel(alias)` is the resolver helper.

## When ACP support arrives

The transport stub at `lib/backends/claude.mjs::createNotYetSupportedTransport`
gets replaced by:

```js
cli(config = {}) {
  return createCliTransport({
    command: config.command ?? "claude",
    args: buildClaudeArgs(config),
    env: config.env,
    cwd: config.cwd
  });
}
```

That's the entire upstream-readiness plan. Tests (`buildClaudeArgs`),
docs (this file + `cli-options-research.md`), and the backend
declaration are all already in place.

## See also

- `docs/cli-options-research.md` — full CLI flag taxonomy across all backends.
- `docs/transport-cli.md` — CliTransport reference (will become Claude's path).
- `docs/architecture.md` — multi-backend layer diagram.
- `docs/backends/gemini.md`, `docs/backends/codex.md` — sibling references.
