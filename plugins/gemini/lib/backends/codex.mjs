/**
 * Codex backend declaration — CLI-only.
 *
 * STATUS (2026-05-11): This backend's transport is currently dead-code
 * against upstream codex 0.130.0+. `buildCodexArgs` emits `["acp", ...]`
 * but the `codex acp` subcommand was removed upstream — codex now
 * exposes a long-running server only via `codex app-server` (its own
 * JSON-RPC 2.0 schema, NOT Zed's ACP wire format). The slash-command
 * hot path (`/codex:prompt`) doesn't reach this declaration; it uses
 * the stateless `runCodexExec` runner (`codex exec --json`). The
 * Codex ACP warm path will return once `lib/translate/codex-app-server.mjs`
 * lands (Option A — see `openspec/changes/add-unified-acp-server-with-mcp-aggregation/`
 * tasks T1.10 + T1.11). Until then the declaration is kept for parity
 * with the gemini/claude backend shape so the migration is a one-file
 * swap (`["acp", ...]` → `["app-server", "--listen", "stdio://", ...]`
 * plus a protocol translator).
 *
 * CLI-specific optimization options are exposed at the factory level:
 *   - `effort`: maps to `codex --effort {none|minimal|low|medium|high|xhigh}`
 *     for reasoning-budget control (Codex 0.42+; lives on subcommands, not
 *     top-level — see docs/backends/codex.md). The portable alias `max`
 *     is accepted and normalized to `xhigh` (codex's highest level) at
 *     the streaming-runner boundary.
 *   - `model`: maps to `codex --model <id>` for per-invocation model
 *     selection without modifying the user's `~/.codex/config.toml`.
 *   - `quiet`: passes `--quiet` to suppress the banner/version preamble
 *     that some CI environments treat as wire-protocol noise.
 *
 * Callers that need to override the binary path (test seam) pass `command`.
 */

import { createCliTransport } from "../transport/cli.mjs";

/**
 * @typedef {import("../acp/client.mjs").ClientTransport} ClientTransport
 *
 * @typedef {object} CodexBackendConfig
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [cwd]
 * @property {string} [command] Override for the spawned binary (test seam).
 * @property {string[]} [args] Override for the full args list (test seam).
 *   Setting this skips `buildCodexArgs` and the optimization options below.
 *   Parity with `geminiBackend.transports.cli`.
 * @property {string[]} [extraArgs] Additional args appended to the canonical `acp`.
 * @property {"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"} [effort]
 *   Codex reasoning-budget knob. Codex itself accepts
 *   `none|minimal|low|medium|high|xhigh`; the portable alias `max` is
 *   normalized to `xhigh` at the streaming-runner boundary.
 * @property {string} [model] Per-invocation model id (e.g. "gpt-5.5", "gpt-5.3-codex").
 * @property {boolean} [quiet] Pass --quiet to suppress banner output.
 *
 * @typedef {object} CodexBackendDeclaration
 * @property {string} name
 * @property {string} defaultModel
 * @property {"none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"} [defaultEffort]
 * @property {ReadonlyMap<string, string>} modelAliases
 * @property {{ cli: (config?: CodexBackendConfig) => ClientTransport }} transports
 * @property {"cli"} defaultTransport
 * @property {{ authCommand: string, configPath: string, envVar: string }} setupHints
 */

/**
 * @type {ReadonlyMap<string, string>}
 */
const MODEL_ALIASES = new Map([
  // Models currently supported by the codex CLI for ChatGPT accounts
  // (verified against the user's `codex` model list 2026-05-12).
  // Older identifiers (gpt-5, gpt-5-codex, o3, o3-mini, o4-mini, spark)
  // were removed — the CLI's upstream rejects them with a 400 "model
  // is not supported when using Codex with a ChatGPT account" for
  // accounts on the ChatGPT (Plus/Pro) plan.
  ["gpt-5.5", "gpt-5.5"],
  ["gpt-5.4", "gpt-5.4"],
  ["gpt-5.3-codex", "gpt-5.3-codex"]
]);

/**
 * Build the Codex CLI argv from the config's optimization knobs.
 *
 * @param {CodexBackendConfig} config
 * @returns {string[]}
 */
export function buildCodexArgs(config) {
  const args = ["acp"];
  if (config.effort) args.push("--effort", config.effort);
  if (config.model) args.push("--model", config.model);
  if (config.quiet) args.push("--quiet");
  if (config.extraArgs?.length) args.push(...config.extraArgs);
  return args;
}

/** @type {CodexBackendDeclaration} */
export const codexBackend = {
  name: "codex",
  defaultModel: "gpt-5.5",
  // Codex's highest reasoning budget; the portable alias "max" maps
  // here at the runner boundary (see normalizeCodexEffort in
  // codex-streaming.mjs).
  defaultEffort: "xhigh",
  modelAliases: MODEL_ALIASES,
  transports: {
    cli(config = {}) {
      return createCliTransport({
        command: config.command ?? "codex",
        args: config.args ?? buildCodexArgs(config),
        env: config.env,
        cwd: config.cwd
      });
    }
  },
  defaultTransport: "cli",
  setupHints: {
    authCommand: "codex login",
    configPath: "~/.codex/auth.json",
    envVar: "OPENAI_API_KEY"
  }
};

/**
 * Resolve a user-visible alias to its concrete model id. Unknown aliases
 * pass through unchanged (matches geminiBackend's resolveGeminiModel
 * contract — never silently rewrite user-supplied identifiers).
 *
 * @param {string | null | undefined} alias
 * @returns {string}
 */
export function resolveCodexModel(alias) {
  const key = alias ?? codexBackend.defaultModel;
  return MODEL_ALIASES.get(key) ?? key;
}
