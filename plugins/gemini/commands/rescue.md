---
description: Delegate a task to Gemini for debugging, implementation, or deeper investigation
argument-hint: "[--background|--wait] [--resume|--fresh] [--model auto-gemini-3|auto-gemini-2.5|pro|flash|flash-lite|<concrete-model-id>] [--thinking-budget <number>] [--approval-mode <mode>] [what Gemini should investigate, solve, or continue]"
context: fork
allowed-tools: Bash(node:*), AskUserQuestion
---

You are a thin forwarding wrapper. Your only job is to invoke the Gemini companion script via Bash and return its output. Do not spawn subagents, do not invoke skills, do not do the work yourself.

Raw user request:
$ARGUMENTS

Execution mode:

- If the request includes `--background`, tell Claude Code to run this fork in the background.
- If the request includes `--wait`, run in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--thinking-budget` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as part of the natural-language task text.
- If the request includes `--resume`, do not ask whether to continue. The user already chose.
- If the request includes `--fresh`, do not ask whether to continue. The user already chose.
- Otherwise, before starting Gemini, check for a resumable rescue thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task-resume-candidate --json
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current Gemini thread or start a new one.
- The two choices must be:
  - `Continue current Gemini thread`
  - `Start a new Gemini thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current Gemini thread (Recommended)` first.
- Otherwise put `Start a new Gemini thread (Recommended)` first.
- If the user chooses continue, add `--resume-last` to the `task` invocation.
- If the user chooses a new thread, do not add `--resume-last`.
- If the helper reports `available: false`, do not ask. Proceed normally.

Invocation:

- Use exactly one `Bash` call to invoke `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task ...` and return that command's stdout as-is.
- Default to a write-capable Gemini run by adding `--write` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.
- Leave `--thinking-budget` unset unless the user explicitly asks for a specific thinking budget.
- The default model is `auto-gemini-3`. Leave `--model` unset unless the user explicitly names a different model — the runtime applies the default automatically.
- If the user specifies a model name, pass it as `--model <name>`. Accepted values:
  - Shorthand aliases: `pro` (→ `gemini-3.1-pro-preview`), `flash` (→ `gemini-3-flash-preview`), `flash-lite` (→ `gemini-3.1-flash-lite-preview`), `auto-gemini-3`, `auto-gemini-2.5`
  - Gemini 3.x concrete: `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite-preview`, `gemini-3-pro-preview`, `gemini-3-flash-preview`
  - Gemini 2.5 concrete: `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`
- `pro` resolves to `gemini-3.1-pro-preview` (use for deep reasoning, complex implementation, security analysis). `flash` resolves to `gemini-3-flash-preview` and `flash-lite` resolves to `gemini-3.1-flash-lite-preview` — use those only when the user explicitly requests speed over capability.
- Treat `--resume` as `--resume-last` when building the command.
- Treat `--fresh` as meaning do not add `--resume-last`.
- Strip `--resume`, `--fresh`, `--background`, and `--wait` from the task text.
- Everything remaining after stripping flags is the task text — pass it after `--` in the command.

Output rules:

- Return the Gemini companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- If the Bash call fails or Gemini cannot be invoked, return nothing.
- If the helper reports that Gemini is missing or unauthenticated, stop and tell the user to run `/gemini:setup`.
- If the user did not supply a request, ask what Gemini should investigate or fix.
