---
description: Run a one-shot Gemini turn from Claude Code via `gemini -p -o stream-json`.
---

Send the prompt to Gemini's stateless `-p` mode and stream the
response back.

# Usage

```
/gemini:prompt <your prompt here>
```

# Behavior

- Spawns `gemini -p <prompt> -o stream-json --approval-mode plan` in cwd
- Streams events through `translateGeminiStreamEvent` → ACP shape
- Returns the accumulated text + tool call summary + usage

# Implementation

The companion script is at `${CLAUDE_PLUGIN_ROOT}/scripts/gemini-prompt.mjs`
and uses `runStatelessTurn(BACKEND_NAMES.GEMINI, options)` from
`#lib/runners/dispatch.mjs`.

`!node ${CLAUDE_PLUGIN_ROOT}/scripts/gemini-prompt.mjs $ARGUMENTS`
