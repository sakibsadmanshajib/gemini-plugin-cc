---
description: Run a one-shot Claude turn from the Gemini host via `claude --print`.
---

Send the prompt to Claude's stateless `--print --output-format=stream-json`
mode and stream the response back.

# Usage

```
/claude:prompt <your prompt here>
```

# Behavior

- Spawns `claude --print --output-format=stream-json <prompt>` in the cwd
- Streams events through `translateClaudeStreamEvent` → ACP shape
- Returns the accumulated text + tool call summary + usage

# Implementation

The companion script is at `${CLAUDE_PLUGIN_ROOT}/scripts/claude-prompt.mjs`
and uses `runStatelessTurn(BACKEND_NAMES.CLAUDE, options)` from
`#lib/runners/dispatch.mjs`.

`!node ${CLAUDE_PLUGIN_ROOT}/scripts/claude-prompt.mjs $ARGUMENTS`
