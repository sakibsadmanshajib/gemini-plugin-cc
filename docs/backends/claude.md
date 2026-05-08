# Claude backend

The Claude backend (`lib/backends/claude.mjs`) is declared for parity with
Gemini and Codex but is **not yet callable** — Anthropic's `claude` CLI
does not currently support ACP mode. Calling `transports.cli({...}).start()`
throws an actionable error:

> `Claude CLI does not yet support ACP mode. The Claude backend is declared for parity with codex/gemini but is not callable until upstream ships ACP support.`

The infrastructure is built so the swap is one-line when ACP arrives:
replace `createNotYetSupportedTransport` with `createCliTransport({ command: "claude", args: buildClaudeArgs(config), ... })`.

## Why declare a non-functional backend?

1. **Multi-backend parity** — the runtime's dispatcher iterates backends
   uniformly; having `claudeBackend` declared keeps that loop simple.
2. **CLI flag taxonomy is research-derived and tested** — `buildClaudeArgs`
   captures the full `claude --help` flag surface (per
   `docs/cli-options-research.md`) and is pinned by 30 tests. When ACP
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
