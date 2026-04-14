---
name: rescue
description: Delegate a task to Gemini for debugging, implementation, or deeper investigation
argument-hint: '<task description> [--background] [--wait] [--resume] [--fresh] [--model <name>] [--thinking-budget <number>] [--approval-mode <mode>]'
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

Route to `gemini:gemini-rescue` subagent.

The subagent handles forwarding to the Gemini companion script. Do not do the work yourself.

Pass through the user's full argument string. The subagent will parse flags and compose the Gemini prompt.
