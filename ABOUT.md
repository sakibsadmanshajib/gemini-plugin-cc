# About — Artagon Agent CLI Plugin Suite

> **One-liner**: Multi-backend agent CLI plugin suite — drive Claude, Codex, and Gemini interchangeably from any host, plus an OpenAI-compatible HTTP facade in front of all three.

## What it is

A monorepo shipping:

1. **Three host-specific Claude Code / Codex CLI plugins** that drive the OTHER backends (cross-pollination model — a plugin in host X talks to backends ≠ X)
2. **A reusable `lib/`** with one runner per backend (`runClaudePrint` / `runCodexExec` / `runGeminiPrint`), a uniform dispatcher (`runStatelessTurn`), pure stream-json translators, and middleware (redaction-first, audit, cost, retry, fallback, cache)
3. **An OpenAI Chat Completions HTTP facade** (`lib/server/openai-facade.mjs`) — point any OpenAI SDK at it, choose the backend via the `model` field, get streaming SSE responses
4. **Two `bin/` CLIs** — `artagon-agent <backend> "<prompt>"` (one-shot) and `artagon-openai-server` (the facade as a daemon)
5. **A legacy `plugins/gemini/`** (broker-shared multi-turn ACP via `gemini --acp`) preserved verbatim for backward compatibility — see [`docs/legacy-gemini-plugin.md`](docs/legacy-gemini-plugin.md)

## What problem it solves

The major coding-agent CLIs each speak different protocols, ship different SDKs, and live in different host platforms. Switching between them — or composing them — requires writing N adapters. This suite collapses that to one library with a uniform shape:

- **One typed `TurnResult`** regardless of which CLI ran
- **One dispatcher** (`runStatelessTurn(BACKEND_NAMES.X, options)`)
- **One HTTP facade** (`POST /v1/chat/completions` with `model="claude-…" | "gpt-5" | "gemini-…"`)
- **One install path** per host, with cross-driving slash commands for the other backends

## Status

- Full test suite green (unit + integration + property), 0 typecheck errors, biome clean — see the CI badge in [README](README.md) for live status
- npm provenance + CycloneDX SBOM signing wired into `.github/workflows/npm-publish.yml`
- Triggered by `git tag -s v* && git push --tags`

## Topics for repo discovery

`agent-cli` `claude-code` `codex-cli` `gemini-cli` `openai-compatible` `openai-api` `chat-completions-api` `multi-backend` `acp` `cli-plugin` `plugin-marketplace` `stream-json` `sse-streaming` `cyclonedx-sbom` `npm-provenance` `sigstore`

## Quick links

- [README](README.md) — install paths + quick examples
- [`docs/architecture.md`](docs/architecture.md) — layered shape
- [`docs/plugins.md`](docs/plugins.md) — multi-plugin cross-pollination model
- [`docs/runners.md`](docs/runners.md) — runners + dispatcher + TurnResult shape
- [`docs/cli-options-research.md`](docs/cli-options-research.md) — per-CLI flag taxonomy
- [`CHANGELOG.md`](CHANGELOG.md) — release history

## Authors

Artagon & Giedrius Trumpickas

## License

MIT
