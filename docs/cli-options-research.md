# CLI options research — session, resume, stateless

Captured from `--help` output of installed binaries on 2026-05-08. Each
backend has a different session-management philosophy; the multi-backend
runtime needs to absorb the difference at the CLI-adapter layer rather
than push it into callers.

## Gemini (`gemini`)

ACP mode owns session lifecycle in-band over JSON-RPC. The CLI-level
session flags only apply outside ACP mode (interactive or `--prompt`).

### Session passing

- **In ACP mode**: `session/new` → server returns `sessionId`; subsequent
  `session/load`/`session/prompt`/`session/cancel` reference it. There is
  no CLI flag to inject a session id at spawn time; sessions are owned by
  the agent's stored history.
- **Outside ACP**: no `--session-id` flag. Sessions are persisted by
  the agent and addressed by index or name via `--resume`.

### Resume

- `-r, --resume <value>` — `"latest"` for most recent, or numeric index
  (e.g. `--resume 5`). Only meaningful in interactive or `-p` modes.
- `--list-sessions` — list available sessions for current project.
- `--delete-session <index>` — delete by index.

### Stateless

- `-p, --prompt <text>` — non-interactive (headless). One prompt, exit.
  Each run creates a new session unless explicitly resumed; the agent
  still records the run unless that's been disabled in settings.

### CLI-specific optimization options

- `--approval-mode <default|auto_edit|yolo|plan>` — primary safety knob.
- `-y, --yolo` — equivalent to `--approval-mode yolo`.
- `-m, --model <id>` — per-invocation model.
- `-w, --worktree <name>` — start in a fresh git worktree.
- `--include-directories <list>` — additional directories in workspace.
- `-o, --output-format <text|json|stream-json>` — for non-ACP modes.
- `--policy <files>` / `--admin-policy <files>` — policy engine inputs.

## Codex (`codex`)

Distinct subcommand surface. ACP mode is `codex acp`; stateless is
`codex exec`. Sessions are persisted to `~/.codex/...` and addressed by
UUID or thread name.

### Session passing

- **In ACP mode** (`codex acp`): same as Gemini — `session/new`/`session/load`
  via JSON-RPC. No spawn-time flag.
- **Outside ACP**: no `--session-id` flag at spawn; sessions are addressed
  via subcommands.

### Resume

- `codex resume [SESSION_ID] [PROMPT]` — interactive picker by default;
  positional UUID or thread name selects directly.
- `codex resume --last` — continue most recent without picker.
- `codex resume --all` — disable cwd filter.
- `codex resume --include-non-interactive` — include `exec`-created sessions.
- `codex exec resume` — same shape inside the non-interactive subcommand.
- `codex fork` — fork (clone) a previous session into a new one.

### Stateless

- `codex exec [PROMPT]` — non-interactive single turn.
- Stdin piping: prompt from arg or stdin (with `-` to force stdin).

### CLI-specific optimization options

- `-m, --model <id>` — per-invocation model.
- `-c key=value` — TOML config override (dotted-path supported, e.g.
  `-c model="o3"` or `-c sandbox_permissions='["disk-full-read-access"]'`).
- `-p, --profile <name>` — config profile from `~/.codex/config.toml`.
- `-s, --sandbox <read-only|workspace-write|danger-full-access>` —
  sandbox policy.
- `--enable <feature>` / `--disable <feature>` — feature flags.
- `--oss` — use open-source provider; `--local-provider <lmstudio|ollama>`.

Note: codex does **not** ship a `--effort` flag at the top level. Effort
is configured via `-c reasoning_effort=...` or in the profile.

## Claude (`claude`)

No ACP mode in the current binary (verified — no `--acp` flag in help).
Session management lives entirely at the CLI-flag layer with native
support for explicit UUIDs.

### Session passing

- `--session-id <uuid>` — use specific session UUID. If the UUID is new,
  Claude creates the session; if it exists, Claude joins it. **This is
  the only one of the three CLIs with a true spawn-time session id.**
- `-n, --name <display>` — set a display name (visible in `/resume` picker
  and terminal title).

### Resume

- `-r, --resume [value]` — by session id, or interactive picker with
  optional search term.
- `-c, --continue` — most recent conversation in current directory.
- `--fork-session` — when resuming, create a new session id instead of
  reusing the original (use with `--resume` or `--continue`).
- `--from-pr [value]` — resume a session linked to a PR by number/URL,
  or open a PR-search picker.

### Stateless

- `-p, --print` — print response and exit.
- `--no-session-persistence` — disable session-to-disk save (only
  combinable with `--print`). Combined with `--print`, this is "true"
  stateless: nothing is persisted, no session id surfaces.
- `--bare` — minimal mode: skip hooks, LSP, plugin sync, attribution,
  auto-memory, background prefetches, keychain reads, CLAUDE.md
  auto-discovery. Sets `CLAUDE_CODE_SIMPLE=1`. Useful for hermetic runs
  in CI.

### CLI-specific optimization options

- `--effort <low|medium|high|xhigh|max>` — reasoning budget. Note
  `xhigh` is unique to Claude (codex/gemini don't have this tier).
- `--model <alias-or-id>` — `sonnet` / `opus` / `haiku` aliases or full
  ids like `claude-sonnet-4-6`.
- `--fallback-model <id>` — auto-fallback when default is overloaded
  (only works with `--print`).
- `--permission-mode <acceptEdits|auto|bypassPermissions|default|dontAsk|plan>`.
- `--max-budget-usd <amount>` — cap spend (only with `--print`).
- `--add-dir <dirs...>` — additional dirs allowed for tool access.
- `--allowedTools` / `--disallowedTools` — explicit tool allowlist.
- `--system-prompt` / `--append-system-prompt` — system prompt control.
- `--mcp-config <files>` / `--strict-mcp-config` — MCP server overrides.
- `--input-format text|stream-json` — for streaming input.
- `--output-format text|json|stream-json` — structured output.
- `--include-partial-messages` — partial chunks (with `stream-json`).
- `--json-schema <schema>` — structured-output validation.
- `--include-hook-events` — full lifecycle hook events.
- `--exclude-dynamic-system-prompt-sections` — improves prompt-cache reuse.

## Output formats

Each backend's CLI surfaces a different shape for "give me machine-parseable
output." None match exactly — the runtime needs a translator at this layer
or downstream.

### Gemini

- `-o, --output-format <text|json|stream-json>` — only meaningful in
  non-ACP modes (`-p`, interactive). ACP mode always speaks JSON-RPC.
  - `text`: human-readable single block. Default.
  - `json`: single JSON envelope at end-of-turn.
  - `stream-json`: one JSON event per line as the turn progresses.
- `--raw-output` — disable sanitization of model output (allow ANSI etc.).
  Carries a security warning; pair with `--accept-raw-output-risk` to
  suppress the warning.

### Codex

- `codex exec --json` — emit JSONL event stream (one JSON event per line).
  This is the ONLY structured-output toggle on `exec`; there is no
  `--output-format` flag.
- `codex exec --output-schema <file>` — JSON Schema describing the
  model's final response shape (validates the final assistant message,
  not individual events).
- `codex exec -o, --output-last-message <file>` — write the final
  assistant message to a file (text). Useful for shell pipelines that
  only care about the final answer.
- `codex acp` — speaks JSON-RPC over stdio; output format is fixed by
  the protocol (no flag to select).

### Claude

- `--output-format <text|json|stream-json>` — only with `--print`.
  - `text`: plain text. Default.
  - `json`: single JSON envelope `{type, subtype, result, usage, ...}`.
  - `stream-json`: one JSON event per line.
- `--input-format <text|stream-json>` — only with `--print`. `stream-json`
  enables realtime streaming input (multi-turn over a single subprocess).
- `--include-partial-messages` — emit partial-message chunks (only with
  `--print --output-format=stream-json`).
- `--include-hook-events` — include lifecycle hook events in the stream
  (only with `--output-format=stream-json`).
- `--json-schema <schema>` — JSON Schema for structured-output validation.
- `--replay-user-messages` — re-emit user messages on stdout for
  acknowledgment (only with `--input-format=stream-json
--output-format=stream-json`).

### Cross-backend output-format mapping

| Concept                | Gemini                 | Codex                                    | Claude                                |
| ---------------------- | ---------------------- | ---------------------------------------- | ------------------------------------- |
| Single-shot text       | `-o text` (default)    | `exec` (default)                         | `--print` (default)                   |
| Final JSON envelope    | `-o json`              | `exec --output-last-message`<sup>†</sup> | `--print --output-format=json`        |
| Streaming JSON events  | `-o stream-json`       | `exec --json`                            | `--print --output-format=stream-json` |
| Schema-validated final | (n/a)                  | `exec --output-schema <file>`            | `--print --json-schema <schema>`      |
| ACP / JSON-RPC         | `--acp` (fixed format) | `acp` (fixed format)                     | (not yet supported)                   |

<sup>†</sup> Codex's `--output-last-message` writes plain text to a file,
not JSON. There is no Codex equivalent for "final JSON envelope at exit"
short of parsing the last event from `--json` stream.

### Drift to expect

- **Event-name divergence** in `stream-json` is high: Claude streams
  `assistant`/`user`/`result`/`system` envelopes; Codex streams
  `item.created`/`exec_command.{started,completed,output}`/`turn.completed`;
  Gemini streams `agent_message_chunk`/`tool_call`/`turn_completed`.
  None map cleanly to ACP without per-backend translation. Translators
  for SDK-shape events were removed in the CLI-only pivot — equivalent
  per-backend translators for `stream-json` event shapes will need to be
  reconstructed from each CLI's documented event list.
- **Tool-call shapes** differ: Claude uses `tool_use` blocks inside an
  `assistant` envelope; Codex emits `exec_command.*` for shell calls and
  separate envelopes for editor tools; Gemini emits flat `tool_call`
  notifications. The drift surface from research above suggests an ACP
  `session/update` translator per backend, parameterized by which event
  type each `stream-json` line carries.

## Cross-backend invariants

| Concept               | Gemini          | Codex                    | Claude                     |
| --------------------- | --------------- | ------------------------ | -------------------------- | -------- | ------------------------------- | ----- | ----- |
| ACP mode              | `--acp`         | `acp`                    | (not yet supported)        |
| Stateless one-shot    | `-p <prompt>`   | `exec <prompt>`          | `--print`                  |
| Resume                | `--resume <idx  | latest>`                 | `resume <id                | --last>` | `--resume <id>` or `--continue` |
| Spawn-time session id | (n/a)           | (n/a)                    | `--session-id <uuid>`      |
| Fork on resume        | (n/a)           | `fork`                   | `--fork-session`           |
| No-persist            | (settings only) | (config-file only)       | `--no-session-persistence` |
| Per-call model        | `-m <id>`       | `-m <id>` or `-c model=` | `--model <id>`             |
| Effort                | (n/a)           | (n/a)                    | `--effort <low             | medium   | high                            | xhigh | max>` |

## Implications for the CLI adapter layer

The `transports.cli(config)` factory should accept a normalized config
shape that maps to each backend's CLI taxonomy:

```js
{
  // Universal
  cwd, env, command, extraArgs,

  // Operation mode (NOT all backends support all modes):
  mode: "acp" | "stateless" | "resume",

  // For mode === "stateless":
  prompt,                  // gemini -p / codex exec / claude --print
  noPersist,               // claude --no-session-persistence (only)

  // For mode === "resume":
  resumeId,                // gemini --resume / codex resume <id> / claude --resume
  resumeLatest,            // gemini --resume latest / codex resume --last / claude --continue
  forkSession,             // codex fork / claude --fork-session

  // For claude only (others ignore):
  sessionId,               // claude --session-id <uuid>

  // Per-backend optimization knobs (validated per-backend):
  model, effort, permissionMode, sandbox, profile, configOverrides
}
```

Per-backend factories validate and emit only the flags that backend
supports; unsupported options (e.g. `effort` on gemini, `sessionId` on
codex/gemini, `--acp` on claude) yield a clear error rather than being
silently dropped. This matches the project's "no silent fallbacks"
posture from `lib/middleware/`.

## See also

- `lib/transport/cli.mjs` — the underlying CliTransport factory.
- `lib/backends/{gemini,codex,claude}.mjs` — backend declarations that
  consume this taxonomy.
- `docs/architecture.md` — multi-backend layering.
