# STATUS: OBSOLETE

This change proposed an in-process Claude backend driven by the
`@anthropic-ai/claude-agent-sdk` package, with a custom translator
mapping Claude SDK events to ACP `session/update` notifications. It
has been **superseded by the CLI-only pivot (2026-05-08)**.

## What replaced it

- `lib/backends/claude.mjs` ships the Claude backend declaration.
- It exposes a single `transports.cli` factory.
- The Claude CLI does **not yet** support ACP mode (`claude --acp` is
  not a real flag at time of writing). The `cli` factory therefore
  returns a placeholder transport that throws an actionable error on
  `start()`. The infrastructure is ready for a one-line swap when
  upstream Anthropic ships ACP support.
- `buildClaudeArgs(config)` is the pure argv builder, codifying the
  full Claude CLI flag taxonomy from `claude --help` (per
  `docs/cli-options-research.md`). 30 unit tests pin its behavior.
- See `docs/backends/claude.md` for the contract and the swap plan.

## Why the SDK approach was abandoned

Same rationale as `../add-codex-sdk-backend/STATUS.md`. The CLI-only
pivot also retired the SDK translator surface entirely
(`lib/backends/claude/translator.mjs` — deleted, along with its
12-test file).

## Why ship a non-functional Claude backend at all?

1. **Multi-backend parity** — the runtime's dispatcher iterates
   backends uniformly. A declared-but-stubbed Claude entry keeps that
   loop simple.
2. **CLI flag taxonomy is research-derived and tested** — when ACP
   arrives, no argv work needs to happen. `buildClaudeArgs` already
   handles `--session-id`, `--resume`, `--print`,
   `--no-session-persistence`, `--effort` (with `xhigh` and `max`
   tiers unique to Claude), `--permission-mode`, `--add-dir`,
   `--system-prompt`, etc.
3. **Failures are loud** — `transports.cli({...}).start()` throws
   synchronously, not silently after a hung handshake.

## Reading order

1. This file (status).
2. `proposal.md` and `tasks.md` here (the original SDK plan).
3. `lib/backends/claude.mjs` (current declaration with stub transport).
4. `tests/unit/claude-args-builder.test.mjs` (`buildClaudeArgs` tests).
5. `docs/backends/claude.md` (current docs incl. swap plan).
