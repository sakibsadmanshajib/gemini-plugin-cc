---
name: result
description: Show the stored final output for a finished Gemini job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" result "$ARGUMENTS"`

Output rules:
- Present the full command output to the user.
- Do not paraphrase, summarize, condense, or add commentary.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Ask the user which issues, if any, they want fixed before touching a single file.
