---
description: Run a one-shot Codex turn from Claude Code via `codex exec --json`.
---

Send the prompt to Codex's stateless `exec --json` mode and stream the
response back.

# Usage

```
/codex:prompt <your prompt here>
```

# Behavior

- Spawns `codex exec --json <prompt>` in the current working directory
- Streams events through `translateCodexStreamEvent` → ACP shape
- Returns the accumulated text + tool call summary

# Implementation

The companion script is at `${CLAUDE_PLUGIN_ROOT}/scripts/codex-prompt.mjs`
and uses `runStatelessTurn(BACKEND_NAMES.CODEX, options)` from
`#lib/runners/dispatch.mjs`.

`!node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-prompt.mjs $ARGUMENTS`
