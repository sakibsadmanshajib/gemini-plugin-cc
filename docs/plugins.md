# Plugins

This repository hosts **three plugins**, each named for its install
host (not for the backend it drives). The model is cross-pollination:
a plugin installed in host X provides slash commands that drive the
OTHER two backends.

## The cross-pollination matrix

| Plugin            | Install host   | Drives          | Slash commands                           |
| ----------------- | -------------- | --------------- | ---------------------------------------- |
| `plugins/claude/` | Claude Code    | Codex + Gemini  | `/codex:prompt`, `/gemini:prompt`        |
| `plugins/codex/`  | Codex CLI      | Gemini + Claude | `/gemini:prompt`, `/claude:prompt`       |
| `plugins/gemini/` | (legacy + TBD) | Gemini (legacy) | `/gemini:review`, `/gemini:status`, etc. |

The legacy `plugins/gemini/` predates the cross-pollination model —
it's the original "drive Gemini from Claude Code" plugin and is the
production runtime today. Its commands are _not_ cross-pollination;
they invoke `runAcpPrompt`/`runAcpReview` against `gemini --acp`. See
"Legacy plugin" below.

## Why this naming?

Two reasons:

1. **One install per host.** A user runs Claude Code AND Codex CLI; they
   shouldn't install `plugins/gemini/` in both — they need a Claude-Code
   plugin and a Codex-CLI plugin. Naming by host makes the install
   target obvious.
2. **Bridges, not adapters.** Each plugin is a bridge OUT of its host
   to the other backends. The host's own backend doesn't need a slash
   command (it's already what the user is talking to). Naming by host
   makes the "drives the OTHERS" intent explicit.

The structural test `tests/unit/multi-plugin-scaffold.test.mjs` enforces
the cross-pollination invariant: a plugin's scripts MUST NOT reference
its own host's `BACKEND_NAMES.<HOST>` constant. This catches accidental
self-driving (e.g. claude-plugin shipping a `/claude:*` command).

## Anatomy of a plugin

Each plugin has the same shape:

```
plugins/<host>/
├── .claude-plugin/plugin.json    # manifest for Claude Code
├── .codex-plugin/plugin.json     # manifest for Codex CLI (byte-equiv)
├── commands/<other>-prompt.md    # slash command markdown per other backend
└── scripts/<other>-prompt.mjs    # entry script per command
```

The `.claude-plugin/` and `.codex-plugin/` manifests are
**byte-equivalent**. A plugin installed under either host has the same
identity (`name`, `version`, `description`); the host distinguishes
itself via `marketplace.json` source-shape (string vs object) and via
which env vars it sets at runtime (per the existing `Host detection`
contract — `CLAUDE_ENV_FILE` ⇒ Claude Code; otherwise Codex).

Each `scripts/<other>-prompt.mjs` is a thin wrapper:

```js
import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";

const turn = await runStatelessTurn(BACKEND_NAMES.<OTHER>, {
  prompt: process.argv.slice(2).join(" ").trim(),
  cwd: process.cwd(),
  env: process.env,
  timeoutMs: 5 * 60 * 1000  // sane default for one-shot
});

process.stdout.write(turn.text);
```

The dispatcher routes to the right runner; the runner builds argv,
spawns, streams, translates events to ACP shape, accumulates a
`TurnResult`, and returns. See `docs/runners.md` for the full pipeline.

## Marketplace descriptors

Both `.claude-plugin/marketplace.json` (Claude Code) and
`.agents/plugins/marketplace.json` (Codex CLI) list all three plugins.
Per-host source shape:

- Claude Code expects a string: `source: "./plugins/claude"`
- Codex CLI expects an object: `source: {source: "local", path: "./plugins/claude"}`

`tests/unit/marketplace-multi-plugin.test.mjs` verifies the set
agreement (both descriptors list the same plugin names) and the
per-host shape, and that each `source` resolves to an existing plugin
directory with the appropriate manifest file.

## Legacy plugin (`plugins/gemini/`)

Predates the cross-pollination model. Original purpose: install in
Claude Code, drive Gemini via `gemini --acp` long-running broker
session. Provides:

- `/gemini:review`, `/gemini:adversarial-review`, `/gemini:rescue`
- `/gemini:setup`, `/gemini:status`, `/gemini:result`, `/gemini:cancel`
- Hooks: `SessionStart` / `SessionEnd` / `Stop` (review-gate)
- State management under `$CLAUDE_PLUGIN_DATA/state/<slug>-<hash>/`

Under the cross-pollination naming, this plugin is misnamed (it's
installed in Claude Code; it should be `plugins/claude/`). But:

- It has 234+ tests and a ratcheted history of bug fixes.
- It's the production runtime.
- Its commands are full ACP-driven (broker + multi-turn), not
  stateless one-shot.
- The new `plugins/claude/` ships only stateless one-shot commands.

The two are **complementary** today, not competing. The legacy plugin
provides the rich Gemini-driving commands; the new claude/codex plugins
provide cross-driving stateless commands. A future iteration could
either:

1. Fold the legacy commands into `plugins/claude/` (they share a host)
   and rename the directory.
2. Keep `plugins/gemini/` as the canonical Gemini-driving plugin and
   accept the naming asymmetry as historical.

For now: leave alone. Both ship. Users install whichever fits their
needs; nothing about the cross-pollination plugins prevents the legacy
one from working.

## Adding a new command to an existing plugin

1. Create `plugins/<host>/commands/<other>-<verb>.md` with frontmatter
   `description: ...` and a body referencing
   `${CLAUDE_PLUGIN_ROOT}/scripts/<other>-<verb>.mjs`.
2. Create `plugins/<host>/scripts/<other>-<verb>.mjs` that calls
   `runStatelessTurn(BACKEND_NAMES.<OTHER>, ...)` with appropriate
   options (e.g. `approvalMode: "plan"` for review-style commands).
3. Update `tests/unit/multi-plugin-scaffold.test.mjs` if the new
   command's host/backend pair adds a new invariant to assert.

## Adding a new plugin (not yet needed)

If a fourth backend lands (e.g. Bedrock, Mistral), the model expands:

1. Add the new name to `BACKEND_NAMES` in `lib/backends/names.mjs`.
2. Add a new backend module `lib/backends/<name>.mjs` + argv builder.
3. Add a new translator `lib/translate/<name>-stream.mjs` if the CLI
   speaks a non-ACP event format.
4. Add a new runner `lib/runners/<name>-<mode>.mjs`.
5. Wire into `runStatelessTurn` (a new switch case).
6. Add `plugins/<name>/` if there's a host platform installing plugins
   for that backend.
7. Update each existing plugin's commands to drive the new backend
   (per the cross-pollination model: every plugin drives every OTHER
   backend).

## See also

- `docs/architecture.md` — overall layered shape.
- `docs/runners.md` — the runStatelessTurn dispatcher + per-backend runners.
- `docs/cli-options-research.md` — per-CLI flag taxonomy.
- `docs/backends/{gemini,codex,claude}.md` — per-backend specifics.
