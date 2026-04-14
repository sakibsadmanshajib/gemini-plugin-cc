---
name: adversarial-review
description: Run a steerable adversarial Gemini review of working-tree or branch changes in this repository
argument-hint: '[focus text] [--base <ref>] [--scope <auto|working-tree|branch>] [--wait|--background] [--model <name>] [--json]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" adversarial-review $ARGUMENTS`

Output rules:
- Present the review output to the user exactly as returned.
- Do not paraphrase, summarize, or add your own commentary.
- Do not make any code changes based on the review findings.
- CRITICAL: After presenting review findings, STOP. Do not fix any issues. Ask the user which issues, if any, they want addressed before touching a single file.
