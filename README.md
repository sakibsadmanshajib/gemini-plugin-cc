# Artagon Agent CLI Plugin Suite

[![npm version](https://img.shields.io/npm/v/artagon-agent-cli-plugin.svg)](https://www.npmjs.com/package/artagon-agent-cli-plugin)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.18-brightgreen.svg)](#requirements)
[![CI](https://github.com/artagon/artagon-agent-cli-plugin/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/artagon/artagon-agent-cli-plugin/actions/workflows/test.yml)
[![CodeQL](https://github.com/artagon/artagon-agent-cli-plugin/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/artagon/artagon-agent-cli-plugin/actions/workflows/codeql.yml)
[![CycloneDX SBOM](https://img.shields.io/badge/SBOM-CycloneDX-orange.svg)](.github/workflows/npm-publish.yml)
[![npm provenance](https://img.shields.io/badge/npm-provenance-blue.svg)](.github/workflows/npm-publish.yml)

**Multi-backend agent CLI plugin suite** — write once, drive Claude / Codex / Gemini interchangeably from any host. Ships three host-specific plugins (each drives the OTHER backends), an OpenAI-API-compatible HTTP facade, two `bin/` CLIs, and a reusable JS library under `lib/` for embedding the runners directly.

> **TL;DR** — Get an OpenAI-compatible endpoint that routes to whichever underlying CLI you have installed:
>
> ```sh
> npx -p artagon-agent-cli-plugin artagon-openai-server --port 3000
> # In any OpenAI SDK:  base_url=http://localhost:3000/v1, model="claude-sonnet-4-6"
> ```

## Why

The major coding-agent CLIs (`claude`, `codex`, `gemini`) speak different protocols, ship different SDKs, and live in different host platforms. This suite provides:

- **One library**, three backends — `runStatelessTurn(BACKEND_NAMES.X, options)` returns a `TurnResult` regardless of which CLI ran.
- **One HTTP facade**, three backends — point any OpenAI SDK at `localhost:3000/v1` and use `model="claude-…" | "gpt-5" | "gemini-…"` (or the explicit `<backend>:<model>` form).
- **Three host-specific plugins** — install in Claude Code or Codex CLI to drive the OTHER backends from inside the host with slash commands.

## Install

### Pick whichever fits your context

| Use case                                                    | Install                                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Library / one-off CLI**                                   | `npm i -g artagon-agent-cli-plugin` (or `npx`)                                                                                                                                                         |
| **OpenAI-compatible HTTP server**                           | `npx -p artagon-agent-cli-plugin artagon-openai-server --port 3000`                                                                                                                                    |
| **Claude Code plugin** (drive Codex + Gemini from Claude)   | `claude plugin marketplace add artagon/artagon-agent-cli-plugin` then `claude plugin install claude@artagon-agent-cli-plugin`                                                                          |
| **Codex CLI plugin** (drive Gemini + Claude from Codex)     | Same marketplace registry, then `claude plugin install codex@artagon-agent-cli-plugin` (Codex shares the install registry with Claude Code on this machine — see [`docs/INSTALL.md`](docs/INSTALL.md)) |
| **Gemini-host plugin** (drives Codex + Claude from Gemini)  | `claude plugin install gemini@artagon-agent-cli-plugin`                                                                                                                                                |
| **Legacy `/gemini:*` commands** (single-backend Gemini ACP) | See [`docs/legacy-gemini-plugin.md`](docs/legacy-gemini-plugin.md)                                                                                                                                     |
| **Homebrew**                                                | _Pending — `brew install artagon/tap/artagon-agent-cli-plugin` once the tap is published. See [`docs/homebrew-tap.md`](docs/homebrew-tap.md) for the publish recipe + version-bump workflow._          |

After global install, three binaries are on PATH:

```sh
artagon-agent <backend> "<prompt>" [flags]     # one-shot dispatch
artagon-openai-server [--port N] [--host H]    # OpenAI Chat Completions facade
artagon-stats [--json] [--since <iso>]         # cost / token usage aggregator
```

`artagon-stats` reads the local cost log written by every dispatch (`$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl` by default — see [`docs/observability.md`](docs/observability.md)) and prints a per-backend summary or machine-readable JSON. Use `--budget` / `--budget-usd` to assert against a CI budget.

### Local install for development / testing

If you're developing the plugin or testing an unreleased build:

```sh
git clone https://github.com/artagon/artagon-agent-cli-plugin.git
cd artagon-agent-cli-plugin
pnpm install
pnpm vendor:lib                     # materializes lib/ into each plugin tree (REQUIRED — see Limitations)
claude plugin marketplace add "$(pwd)"
claude plugin install gemini@artagon-agent-cli-plugin
```

The marketplace install copies the plugin source tree as-is and does not run `npm install`. Plugin scripts use `#lib/*` imports that resolve via a per-plugin `package.json`. To make these resolve at install-time, the repo-root `lib/` is **vendored** into each `plugins/<host>/lib/`. This is committed to git but kept in sync via `pnpm vendor:lib` (CI runs `pnpm vendor:lib:check` to fail on drift).

## Quick examples

### One-shot dispatch (any backend)

```sh
artagon-agent claude "Review the staged diff"
artagon-agent codex  "Refactor the cache layer" --effort high
artagon-agent gemini "Summarize what changed in HEAD~1..HEAD"
artagon-agent claude "Write a test plan" --json   # full TurnResult as JSON
```

### OpenAI-compatible HTTP facade

```sh
artagon-openai-server --port 3000
```

```python
# Any OpenAI SDK speaks to it:
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="unused")
resp = client.chat.completions.create(
    model="claude-sonnet-4-6",          # or codex / gemini / "<backend>:<model>"
    messages=[{"role": "user", "content": "summarize this repo"}],
    stream=True,                         # SSE streaming supported
    stream_options={"include_usage": True},  # token tallies in final chunk
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

The facade also supports:

- **CORS**: `--cors '*'` (or single-origin / comma-separated allowlist; or `$ARTAGON_FACADE_CORS`). Off by default for safety. Required when calling from a browser-based client.
- **API-key auth**: `--api-key sk-...` (single or comma-separated; or `$ARTAGON_FACADE_API_KEY`). Off by default. When set, every `/v1/*` request must carry `Authorization: Bearer <key>`. `/health` is exempt.
- **finish_reason mapping**: each backend's stop dialect (`end_turn` / `MAX_TOKENS` / `tool_use`) maps to OpenAI's canonical set (`stop` / `length` / `content_filter` / `tool_calls`).

### Cross-driver from inside a host

After installing the host plugin (Claude Code, Codex CLI, or Gemini), invoke the OTHER backends as slash commands without leaving:

```
# Inside Claude Code (claude plugin installed):
/codex:prompt   "Refactor the cache layer using the strategy pattern"
/gemini:prompt  "Summarize this commit"

# Inside Codex CLI (codex plugin installed):
/claude:prompt  "Review this PR for breaking changes"
/gemini:prompt  "Suggest edge-case tests"

# In a Gemini host (gemini plugin installed):
/claude:prompt  "Architect the migration"
/codex:prompt   "Write the migration script"
```

### Cost observability

Every turn (HTTP facade or direct dispatch) appends a JSONL row to `$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl`. View totals via:

```sh
artagon-stats                    # text summary + 5 most recent
artagon-stats --json --recent 50 # full JSON for tooling
```

Or as slash commands inside any host plugin:

- `/<plugin>:stats` — turns / tokens / wall-clock / per-backend breakdown / **estimated $** + cache savings
- `/<plugin>:budget [--limit N | --limit-usd N] [--month]` — soft budget vs. used; observability, never blocks a turn

Pricing lives in `lib/cost/pricing.mjs` (Claude Sonnet/Opus/Haiku, GPT-5/o-series, Gemini Pro/Flash) with prompt-cache discount tiers (Anthropic 10% read / +25% write, OpenAI 50% read). Override the rate table at runtime via `$ARTAGON_PRICING_OVERRIDE` (JSON).

### Embedded library use

```js
import { runStatelessTurn } from "artagon-agent-cli-plugin/lib/runners/dispatch.mjs";
import { BACKEND_NAMES } from "artagon-agent-cli-plugin/lib/backends/names.mjs";

const turn = await runStatelessTurn(BACKEND_NAMES.CLAUDE, {
  prompt: "Explain this code",
  cwd: process.cwd(),
  timeoutMs: 5 * 60 * 1000,
  onUpdate: (u) => process.stdout.write(u.content?.text ?? ""), // streaming
});
console.log(turn.usage);
```

## Multi-backend cross-pollination

Each plugin is named for its **install host** (not for what it drives). The convention: a plugin in host X provides commands that drive the OTHER backends. The host's own backend is what you're already talking to, so it doesn't need a slash command.

| Plugin            | Install host | Drives          | Cross-pollination commands         |
| ----------------- | ------------ | --------------- | ---------------------------------- |
| `plugins/claude/` | Claude Code  | Codex + Gemini  | `/codex:prompt`, `/gemini:prompt`  |
| `plugins/codex/`  | Codex CLI    | Gemini + Claude | `/gemini:prompt`, `/claude:prompt` |
| `plugins/gemini/` | Gemini host  | Codex + Claude  | `/claude:prompt`, `/codex:prompt`  |

The runtime under `lib/` is **CLI-only** — no in-process SDKs. Per-CLI argv builders + per-CLI translators map each CLI's `stream-json` output to a uniform `TurnResult`. See [`docs/plugins.md`](docs/plugins.md) for the model and [`docs/architecture.md`](docs/architecture.md) for the layered shape.

### Verified end-to-end

All six cross-driver paths (3 hosts × 2 other backends) have been smoke-tested against the real CLI binaries from the marketplace install cache:

| From plugin | → To backend | Result |
| ----------- | ------------ | ------ |
| `claude`    | `codex`      | ✅     |
| `claude`    | `gemini`     | ✅     |
| `codex`     | `claude`     | ✅     |
| `codex`     | `gemini`     | ✅     |
| `gemini`    | `claude`     | ✅     |
| `gemini`    | `codex`      | ✅     |

(Test methodology: `node ~/.config/agents/plugins/cache/.../plugins/<host>/scripts/<other>-prompt.mjs "What is 2+2?"` — every path returns `4` plus a usage record.)

## Requirements

- **Node.js ≥ 18.18** (uses native subpath imports + `fetch`)
- **At least one of**: `claude`, `codex`, `gemini` installed and authenticated for the backends you want to drive
- **For local OpenAI facade only**: nothing else (binds 127.0.0.1)

The plugin **does not manage CLI authentication**. You must already have run `claude /login`, `codex login`, or `gemini auth` (whichever you intend to drive). The plugin shells out to the binary as the current user; whatever auth state the binary has is what gets used.

## Limitations

| Area                                  | Constraint                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Marketplace install ≠ npm install** | The Claude Code / Codex marketplace install copies the plugin tree as-is and does **not** follow symlinks or run `npm install`. The repo-root `lib/` is vendored into each `plugins/<host>/lib/` to compensate. Run `pnpm vendor:lib` before testing a local marketplace install; CI's `pnpm vendor:lib:check` enforces drift-freedom.      |
| **Schema drift risk**                 | Per-CLI translators (`lib/translate/<x>-stream.mjs`) parse each CLI's `stream-json` output. CLI vendors change schemas regularly without semver. We fixed three drift bugs as recently as `ffcd43f`. If a translator returns `null` for the agent-message text event, you'll see empty turn output — file an issue with the raw event JSON. |
| **One-shot only (today)**             | `runStatelessTurn` and the slash commands are stateless — single prompt → single turn → exit. Multi-turn streaming-input variants are roadmap, not shipped.                                                                                                                                                                                 |
| **macOS / Linux only**                | No Windows testing. Symlink-handling, Unix sockets (used by the legacy `/gemini:*` broker), and `cp -R` semantics differ enough on Windows that we don't claim support.                                                                                                                                                                     |
| **Conservative event mapping**        | Translators map only the events they recognize; unknown shapes return `null` and the runner accumulates no text for them. Trade-off: predictable behavior vs. coverage of vendor-specific events. The runner does not infer from unknown shapes.                                                                                            |
| **Cost rates may be stale**           | Pricing in `lib/cost/pricing.mjs` is a snapshot. Vendors change rates quarterly; we update on best-effort. Use `$ARTAGON_PRICING_OVERRIDE` to plug in fresh rates without forking.                                                                                                                                                          |
| **No native OpenRouter / Bedrock**    | Routes-via-the-facade only (treat OpenRouter as `<openrouter-host>:<openai-compat-model>`). Native backend support is roadmap.                                                                                                                                                                                                              |
| **Codex `exec --json` quirks**        | Codex's `exec --json` requires the working directory to be a git repo (or `--skip-git-repo-check`). The runner is currently invoked from the caller's `cwd`; if that's not a git repo, codex will refuse. Pass `extraArgs: ["--skip-git-repo-check"]` to bypass.                                                                            |
| **Vendored lib/ size**                | The committed-vendored `lib/` adds ~324KB × 3 plugin trees ≈ 1MB to the repo. We accept this cost rather than rely on a build step the marketplace install can't run.                                                                                                                                                                       |

## Documentation

| Doc                                                                  | What                                                                               |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [`docs/architecture.md`](docs/architecture.md)                       | Layered system overview + key invariants                                           |
| [`docs/plugins.md`](docs/plugins.md)                                 | Multi-plugin cross-pollination model                                               |
| [`docs/runners.md`](docs/runners.md)                                 | Stateless runners + dispatcher + TurnResult shape                                  |
| [`docs/openai-facade.md`](docs/openai-facade.md)                     | OpenAI Chat Completions HTTP facade — endpoints, auth, CORS, finish_reason mapping |
| [`docs/cli-options-research.md`](docs/cli-options-research.md)       | Per-CLI flag taxonomy (claude/codex/gemini)                                        |
| [`docs/backends/{gemini,codex,claude}.md`](docs/backends/)           | Per-backend specifics                                                              |
| [`docs/middleware-architecture.md`](docs/middleware-architecture.md) | Redaction-first composer + 6 middlewares                                           |
| [`docs/observability.md`](docs/observability.md)                     | Logger / wire-log / OpenTelemetry tracing                                          |
| [`docs/legacy-gemini-plugin.md`](docs/legacy-gemini-plugin.md)       | Original `/gemini:*` commands (broker-shared multi-turn ACP)                       |
| [`docs/INSTALL.md`](docs/INSTALL.md)                                 | Full install recipes for Claude Code and Codex CLI                                 |
| [`CHANGELOG.md`](CHANGELOG.md)                                       | Release history                                                                    |

## Architecture in one diagram

```
host (Claude Code / Codex CLI / OpenAI SDK consumer)
   │
   ▼
Plugin shell (commands/<x>-prompt.md)  │  bin/artagon-agent  │  lib/server/openai-facade
   │
   ▼
runStatelessTurn(BACKEND_NAMES.<X>, options)
   │
   ▼
runners (claude-print / codex-exec / gemini-print)
   │  ↓ buildArgs (pure)        ← argv from typed config
   │  ↓ spawn(<cli>, args)      ← subprocess
   │  ↓ consumeStreamJson       ← line-by-line stream consumer
   │  ↓ translate<X>StreamEvent ← pure event mapper to ACP shape
   ▼
TurnResult { text, toolCalls, toolResults, usage, reason }
```

## Signing, SBOM, attestations

Releases are signed via npm provenance + Sigstore (`npm publish --provenance` over GitHub Actions OIDC) and ship a [CycloneDX SBOM](https://cyclonedx.org/) as a release artifact:

- npm tarball provenance verifiable with `npm audit signatures`
- CycloneDX SBOM (JSON + XML) attached to each GitHub release
- `actions/attest-sbom@v1` and `actions/attest-build-provenance@v1` add separate Sigstore attestations
- Triggered by `git tag -s v* && git push --tags` (see [`.github/workflows/npm-publish.yml`](.github/workflows/npm-publish.yml))

## Security

Vulnerability disclosure goes through a private channel — **do not file public GitHub issues for security bugs**. See [`SECURITY.md`](SECURITY.md) for the full policy:

- Preferred: open a [private security advisory](https://github.com/artagon/artagon-agent-cli-plugin/security/advisories/new)
- Or email `security@artagon.dev`
- 3-business-day acknowledgement, 7-day initial assessment, 90-day default coordinated-disclosure window

The page also indexes the in-repo hardening (CodeQL extended pack, SHA-pinned actions, OIDC provenance, `crypto.timingSafeEqual` for API keys, mode-0o600 cost log, no stack-trace exposure on HTTP errors, PID-reuse-hardened orphan reaper, three-layer credential redaction with cross-layer-invariant CI test).

## Status

**Currently working (verified end-to-end):**

- Three CLI runners (claude/codex/gemini) — stateless one-shot, with `signal`, `timeoutMs`, AbortController-style cancellation
- All 6 cross-driver paths smoke-tested against the marketplace-install cache (see [Verified](#verified-end-to-end) above)
- OpenAI Chat Completions HTTP facade including SSE streaming
- Per-process pid-file orphan tracking
- Multi-backend dispatcher
- 784 passing tests (504 unit + 263 integration + 17 property), 0 typecheck errors, biome clean — see CI badge for live status

**Roadmap:**

- Streaming-input (multi-turn) variants of the runners
- Homebrew tap
- Native OpenRouter and AWS Bedrock backends (today: route via the OpenAI facade)
- Codex `--skip-git-repo-check` propagation as a runner config knob
- Schema-drift CI canary (run real CLIs against canned prompts to catch translator regressions)

## License

MIT — see [`LICENSE`](LICENSE).
