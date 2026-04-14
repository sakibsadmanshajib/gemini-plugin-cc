---
name: gemini-cli-runtime
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
user-invocable: false
---

# Gemini Companion Runtime Contract

## Invocation

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task [flags] -- <prompt>
```

Everything after `--` (or the first non-flag positional) is the task text sent to Gemini.

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--write` | boolean | false | Enable Gemini to make file changes (sets `--approval-mode auto_edit`) |
| `--model <name>` | string | (Gemini default) | Model override: `pro`, `flash`, `flash-lite`, or a concrete model name |
| `--thinking-budget <n>` | integer | (unset) | Thinking token budget for the model |
| `--approval-mode <mode>` | string | `default` | One of: `default`, `auto_edit`, `yolo`, `plan` |
| `--resume-last` | boolean | false | Resume the most recent task thread in this repository |
| `--background` | boolean | false | Run as a detached background job |
| `--wait` | boolean | true | Run in the foreground (default) |
| `--cwd <path>` | string | `$CLAUDE_PROJECT_DIR` | Working directory override |
| `--json` | boolean | false | Emit structured JSON instead of rendered markdown |

## Safety Rules

- Exactly one Bash call per rescue invocation.
- Never chain additional tool calls after the companion returns.
- Never inspect, modify, or second-guess Gemini's output.
- If the companion exits non-zero, return nothing — do not fabricate a response.
- Do not include `--thinking-budget`, `--model`, `--resume-last`, `--background`, or `--wait` in the task text itself. They are runtime controls.

## Output

- `stdout`: Rendered markdown (default) or JSON (`--json`).
- `stderr`: Progress updates during execution.
- Exit code 0 = success, non-zero = failure.
