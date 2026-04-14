# gemini-plugin-cc Design Spec

**Date:** 2026-04-14
**Status:** Approved

## Overview

A Claude Code plugin that delegates tasks to Google's Gemini CLI via ACP (Agent Client Protocol). Full feature parity with `openai/codex-plugin-cc`, adapted for Gemini's model family and CLI interface.

## Architecture

Three layers mirroring the Codex plugin:

1. **Markdown layer** — Commands, agents, skills, prompts via Claude Code's plugin system
2. **Node.js companion layer** — `gemini-companion.mjs` bridges Claude Code to the ACP process
3. **ACP integration layer** — JSON-RPC 2.0 over stdio with broker for connection reuse

### Communication Flow

```
Claude Code ──[Bash tool]──→ gemini-companion.mjs ──[Unix socket]──→ ACP Broker
                                                                        ↕
                                                                   gemini --acp
                                                                   (persistent)
```

- **Broker** (`acp-broker.mjs`): Detached daemon on Unix socket (Linux/macOS) or named pipe (Windows). Owns a single `gemini --acp` child process. Multiplexes JSON-RPC requests.
- **Direct fallback**: If broker is busy/unavailable, companion spawns a fresh `gemini --acp` process for that request.
- **Lifecycle**: Broker starts lazily on first use, shuts down on `SessionEnd`.

## Commands (7)

| Command | Mode | Tools | Behavior |
|---------|------|-------|----------|
| `/gemini:review` | `disable-model-invocation: true` | `Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion` | Collects git diff/status, sends review prompt via ACP `prompt` method |
| `/gemini:adversarial-review` | `disable-model-invocation: true` | Same as review | Steerable review with adversarial prompt template, structured JSON output |
| `/gemini:rescue` | `context: fork` | `Bash(node:*), AskUserQuestion` | Routes to `gemini-rescue` subagent for task delegation |
| `/gemini:setup` | normal | `Bash(node:*), Bash(npm:*), AskUserQuestion` | Checks installation, auth, toggles review gate |
| `/gemini:status` | `disable-model-invocation: true` | `Bash(node:*)` | Shows running/recent jobs via inline `!node` execution |
| `/gemini:result` | `disable-model-invocation: true` | `Bash(node:*)` | Displays stored output for finished jobs |
| `/gemini:cancel` | `disable-model-invocation: true` | `Bash(node:*)` | Cancels active background jobs |

## Subagent

**`gemini-rescue`**: Runs on `sonnet` model. Thin forwarding wrapper that invokes `gemini-companion.mjs task` exactly once and returns stdout verbatim. Loads `gemini-cli-runtime` and `gemini-prompting` skills.

## Skills (3)

1. **`gemini-cli-runtime`** — Invocation contract for `gemini-companion.mjs task`. Flags: `--write`, `--model`, `--resume-last`, `--approval-mode`, `--thinking-budget`.
2. **`gemini-result-handling`** — Output presentation rules: preserve structure, never auto-fix, require user confirmation.
3. **`gemini-prompting`** — Gemini model prompting guide with system instruction patterns, prompt blocks, recipes (diagnosis, fix, review, research), anti-patterns. References in `references/` subdirectory.

## Hooks

| Event | Script | Timeout | Purpose |
|-------|--------|---------|---------|
| `SessionStart` | `session-lifecycle-hook.mjs SessionStart` | 5s | Exports `GEMINI_COMPANION_SESSION_ID` + `CLAUDE_PLUGIN_DATA` env vars |
| `SessionEnd` | `session-lifecycle-hook.mjs SessionEnd` | 5s | Shuts down broker, cleans up session jobs |
| `Stop` | `stop-review-gate-hook.mjs` | 900s | Optional Gemini adversarial review of Claude's last response |

## Prompt Templates

1. **`adversarial-review.md`** — Full adversarial review with role, attack surface, review method, finding bar, structured output contract, grounding rules. Uses `{{VARIABLE}}` interpolation.
2. **`stop-review-gate.md`** — Stop-gate prompt checking if Claude made code changes. Returns `ALLOW: <reason>` or `BLOCK: <reason>`.

## Schema

**`review-output.schema.json`** — `{verdict, summary, findings[], next_steps[]}` where each finding has `severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation`.

## Codex-to-Gemini Mapping

| Codex Pattern | Gemini Equivalent |
|--------------|-------------------|
| `codex app-server` | `gemini --acp` |
| `review/start` method | `prompt` with review prompt + git context |
| `turn/start` with output schema | `prompt` with system instructions requesting JSON |
| `gpt-5.4` / `gpt-5.3-codex-spark` | `pro` / `flash` / `flash-lite` |
| `--effort` (reasoning effort) | `--thinking-budget` / model config |
| `--write` flag | `--approval-mode auto_edit` or `yolo` |
| `~/.codex/config.toml` | `~/.gemini/settings.json` |
| Broker error `-32001` | Same pattern, custom error code |

## File Structure

```
gemini-plugin-cc/
  .claude-plugin/marketplace.json
  plugins/gemini/
    .claude-plugin/plugin.json
    commands/
      review.md
      adversarial-review.md
      rescue.md
      setup.md
      status.md
      result.md
      cancel.md
    agents/gemini-rescue.md
    skills/
      gemini-cli-runtime/SKILL.md
      gemini-result-handling/SKILL.md
      gemini-prompting/
        SKILL.md
        references/
          prompt-blocks.md
          gemini-prompt-recipes.md
          gemini-prompt-antipatterns.md
    prompts/
      adversarial-review.md
      stop-review-gate.md
    schemas/
      review-output.schema.json
    hooks/
      hooks.json
    scripts/
      gemini-companion.mjs
      acp-broker.mjs
      stop-review-gate-hook.mjs
      session-lifecycle-hook.mjs
      lib/
        acp-client.mjs
        acp-protocol.d.ts
        gemini.mjs
        state.mjs
        git.mjs
        render.mjs
        tracked-jobs.mjs
        job-control.mjs
        broker-lifecycle.mjs
        broker-endpoint.mjs
        process.mjs
        prompts.mjs
        args.mjs
        fs.mjs
        workspace.mjs
    LICENSE
  package.json
```

## Design Decisions

1. **ACP over headless mode**: Persistent process reuse, session continuity, model switching. Fallback to direct spawn when broker is busy.
2. **Broker pattern**: Reuses Codex's proven architecture — Unix socket daemon multiplexing requests to a single ACP process.
3. **Full prompting guide**: Gemini-specific prompt engineering skill for effective rescue subagent delegation.
4. **Structured output via system instructions**: Gemini doesn't have a native output schema parameter in ACP, so we use system instructions to request JSON conforming to our schema.
5. **`stream-json` for progress**: Where ACP doesn't provide granular notifications, we can fall back to headless mode with `--output-format stream-json` for tasks needing progress reporting.
