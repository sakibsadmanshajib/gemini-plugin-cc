---
description: Run a Gemini code review of working-tree or branch changes in this repository
argument-hint: '[--base <ref>] [--scope <auto|working-tree|branch>] [--wait|--background] [--model auto-gemini-3|auto-gemini-2.5|pro|flash|flash-lite|<model-id>] [--thinking <off|low|medium|high>] [--stream-output] [--json]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run:

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" review "$ARGUMENTS"`

Flags:
- `--thinking <off|low|medium|high>` selects a requested reasoning level (default: medium). The local Gemini CLI does not expose a per-invocation thinking override yet; the companion parses and validates the flag, emits a one-shot warning, and falls back to the CLI's default reasoning. Configure `thinkingConfig` in Gemini `settings.json` for a persistent setting that takes effect today.
- `--stream-output` streams raw model and thought chunks to stderr during the review. Without it, progress is shown as compact markers.

Output rules:
- Present the review output to the user exactly as returned.
- Do not paraphrase, summarize, or add your own commentary.
- Do not make any code changes based on the review findings.
- If the output is empty or indicates no changes, say so explicitly.
