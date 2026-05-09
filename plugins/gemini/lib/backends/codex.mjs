/**
 * Codex backend declaration — CLI-only.
 *
 * Per the CLI-only architecture, the Codex backend launches the `codex`
 * binary in ACP mode (`codex acp`). SDK and app-server transports were
 * removed in favor of a single uniform shape across backends.
 *
 * CLI-specific optimization options are exposed at the factory level:
 *   - `effort`: maps to `codex --effort {low|medium|high|max}` for
 *     reasoning-budget control (Codex 0.42+).
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
 * @property {"low" | "medium" | "high" | "max"} [effort] Codex reasoning-budget knob.
 * @property {string} [model] Per-invocation model id (e.g. "spark", "gpt-5").
 * @property {boolean} [quiet] Pass --quiet to suppress banner output.
 *
 * @typedef {object} CodexBackendDeclaration
 * @property {string} name
 * @property {string} defaultModel
 * @property {ReadonlyMap<string, string>} modelAliases
 * @property {{ cli: (config?: CodexBackendConfig) => ClientTransport }} transports
 * @property {"cli"} defaultTransport
 * @property {{ authCommand: string, configPath: string, envVar: string }} setupHints
 */

/**
 * @type {ReadonlyMap<string, string>}
 */
const MODEL_ALIASES = new Map([
  ["spark", "spark"],
  ["gpt-5", "gpt-5"],
  ["gpt-5-codex", "gpt-5-codex"],
  ["o3", "o3"],
  ["o3-mini", "o3-mini"],
  ["o4-mini", "o4-mini"]
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
  defaultModel: "spark",
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
