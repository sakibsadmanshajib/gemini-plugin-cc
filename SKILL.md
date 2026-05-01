---
name: gemini
description: Use Google Gemini CLI for code review, adversarial review, debugging, or large-context investigation. Hands off to Gemini's 1M-token context window when the host wants a second opinion or large-context pass instead of solving the task file-by-file.
allowed-tools: Bash, Glob, Read
---

# Gemini (dual-host plugin)

This plugin runs in **both Claude Code AND Codex CLI**. Both hosts shell out to the same `plugins/gemini/scripts/gemini-companion.mjs` runtime, which manages an ACP broker and a persistent `gemini --acp` session.

## When To Use Gemini

| Scenario | Why Gemini fits |
|---|---|
| Code review with cross-file scope | 1M-token context surfaces transitive callers in one pass |
| Adversarial / skeptical review | Different reasoning style than Claude/Codex; catches what the implementer missed |
| Architecture impact for a large refactor | Trace callers, dependencies, breakage radius across the repo |
| Long-context investigation | "Read these 40 files and tell me where the bug originates" |
| Documentation synthesis | Read many files, produce one coherent doc |

## Host Entry Points

### Claude Code

Use the slash commands:

```
/gemini:setup                 # check install + auth
/gemini:review                # neutral code review of working tree or branch
/gemini:adversarial-review    # steerable challenge review
/gemini:rescue <task>         # delegate task to Gemini (--background, --resume, --thinking high)
/gemini:status / :result / :cancel    # job control
```

### Codex CLI

Codex auto-discovers this plugin via:
- `.codex-plugin/plugin.json` (canonical Codex manifest, at `plugins/gemini/.codex-plugin/plugin.json`)
- Root `SKILL.md` (this file)
- `agents/openai.yaml` (implicit-invocation contract)

Invoke implicitly via `$gemini <task>`, or shell out directly:

```bash
node plugins/gemini/scripts/gemini-companion.mjs review --base origin/main
node plugins/gemini/scripts/gemini-companion.mjs adversarial-review "focus on race conditions"
node plugins/gemini/scripts/gemini-companion.mjs task --thinking high "investigate why test X flakes"
```

See `docs/INSTALL.md` for install instructions covering both Claude Code and Codex CLI (Codex uses the personal marketplace at `~/.agents/plugins/marketplace.json` per OpenAI's documented Codex plugin path; Claude Code uses `/plugin marketplace add` + `/plugin install`).

## Setup (one-time)

```bash
node plugins/gemini/scripts/gemini-companion.mjs setup --json
```

Requires `gemini` CLI on `$PATH` and a Google account or Gemini API key. If `gemini` is missing the setup helper offers `npm install -g @google/gemini-cli`.

## Output Discipline

When the host relays Gemini's output to the user:
- Present the review/analysis text verbatim.
- Do not paraphrase or summarize.
- Do not make code changes based on the review without asking the user which findings they want addressed.

## Dual-Host Runtime Notes

**Host detection.** The runtime detects "is this Claude Code?" via the `CLAUDE_ENV_FILE` env var, which is set only by Claude Code's session lifecycle hook. Codex never sets it. This is more robust than checking `CLAUDE_PLUGIN_DATA` alone — a user who exports `CLAUDE_PLUGIN_DATA` in their shell rc must not pull Codex into Claude's state tree.

**State paths.**
- Claude Code (when `CLAUDE_ENV_FILE` is set AND `CLAUDE_PLUGIN_DATA` is set): `${CLAUDE_PLUGIN_DATA}/state/<workspace-hash>/`
- Otherwise (Codex CLI, or Claude Code without the hook): `${TMPDIR}/gemini-companion/<workspace-hash>/`

The two state roots do not share. Each host runs its own broker against its own session file.

**Broker lifecycle.**
- Claude Code: `SessionEnd` hook tears down the broker cleanly via `sendBrokerShutdown` + `teardownBrokerSession`.
- Codex: no `SessionEnd` hook exists. The runtime reaps stale brokers (session file mtime older than 1 hour AND endpoint not responding) at the top of every `ensureBrokerSession` call. This bounds orphan-process accumulation under Codex.

**Job control.** `status`/`result`/`cancel` are per-host. Claude Code's `GEMINI_COMPANION_SESSION_ID` env var (set by `session-lifecycle-hook.mjs`) scopes status filtering to the current session. Codex does not set it, so Codex-side status calls show all jobs in the workspace state tree by default.

**Background jobs.** `--background` and `--resume` work in both hosts.

## See Also

- `README.md` — full plugin documentation
- `docs/INSTALL.md` — install recipe for both Claude Code and Codex CLI
- `.agents/plugins/marketplace.json` — Codex marketplace descriptor (canonical path per OpenAI docs)
- `.claude-plugin/marketplace.json` — Claude Code marketplace descriptor
- `plugins/gemini/commands/` — Claude Code slash command definitions
- `agents/openai.yaml` — Codex implicit-invocation interface (consumed by Codex's plugin loader at the source-dir root; Claude Code does not use it)
- `plugins/gemini/.codex-plugin/plugin.json` — canonical Codex plugin manifest
- `plugins/gemini/.claude-plugin/plugin.json` — Claude Code plugin manifest (byte-identical to Codex variant)
- `plugins/gemini/scripts/gemini-companion.mjs` — the host-agnostic runtime

> **Note for future contributors:** The fork-root `SKILL.md` (this file) and `agents/openai.yaml` are **Codex-only** — they support Codex's auto-discovery model, which scans the plugin install root for those files. Claude Code does NOT consume them and will not include them in its plugin install (Claude Code installs from `plugins/gemini/`, which is a strict subtree). This is intentional, not a bug.
