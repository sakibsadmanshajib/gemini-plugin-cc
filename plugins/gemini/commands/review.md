---
description: Run a Gemini code review of working-tree or branch changes in this repository
argument-hint: '[--base <ref>] [--scope <auto|working-tree|branch>] [--wait|--background] [--model <name>] [--json]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "$ARGUMENTS"`

Output rules:
- Present the review output to the user exactly as returned.
- Do not paraphrase, summarize, or add your own commentary.
- Do not make any code changes based on the review findings.
- If the output is empty or indicates no changes, say so explicitly.
