/**
 * Gemini backend declaration.
 *
 * Each backend is a small object that pairs:
 *   - identity (`name`),
 *   - model surface (`modelAliases`, `defaultModel`),
 *   - transport factories (`transports`),
 *   - setup/onboarding hints (`setupHints`).
 *
 * The runtime (currently `plugins/gemini/scripts/gemini-companion.mjs`,
 * eventually a multi-backend dispatcher) calls `backend.transports.cli(config)`
 * to get an `AcpSession`. For now this layer is parallel to the legacy
 * `acp-broker.mjs` / `acp-client.mjs` runtime — adding the third leg of
 * the architecture so subsequent changes can swap in.
 *
 * The model alias map mirrors `gemini-companion.mjs::MODEL_ALIASES` so a
 * v2 dispatcher can resolve user-visible aliases without re-importing the
 * legacy companion. When the legacy companion is retired, this becomes
 * the single source of truth — keep them in sync until then (see the
 * `Flag Value Domains` requirement in `gemini-plugin-baseline`).
 */

import { createCliTransport } from "../transport/cli.mjs";

/**
 * @typedef {import("../acp/client.mjs").ClientTransport} ClientTransport
 *
 * @typedef {object} BackendConfig
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [cwd]
 * @property {string} [command] Override for the spawned binary (test seam).
 * @property {string[]} [args] Override for the full args list (test seam).
 *   Setting this skips `buildGeminiArgs` and the launch options below.
 *
 * --- Gemini-specific launch optimization options (per docs/cli-options-research.md) ---
 *
 * @property {boolean} [yolo] `--yolo`: auto-approve every tool call. Equivalent to
 *   `--approval-mode yolo` but accepted as a more discoverable flag.
 * @property {"default" | "auto_edit" | "yolo" | "plan"} [approvalMode]
 *   `--approval-mode <mode>`. Mutually exclusive with `yolo`; if both set,
 *   the explicit `approvalMode` wins.
 * @property {string} [worktree] `-w, --worktree <name>`: launch in a fresh
 *   git worktree. Empty string is meaningless and gets dropped.
 * @property {string[]} [includeDirectories] `--include-directories <list>`:
 *   additional dirs in the workspace. Joined with comma per gemini's
 *   array-flag convention.
 * @property {string[]} [policyFiles] `--policy <files>` (repeatable). Each
 *   entry produces a separate `--policy <path>` pair.
 * @property {string[]} [adminPolicyFiles] `--admin-policy <files>` (repeatable).
 * @property {boolean} [sandbox] `-s, --sandbox`: run inside the Gemini sandbox.
 * @property {string} [model] `-m, --model <id>`. ACP mode also accepts model
 *   selection via `session/set_model` JSON-RPC; the launch flag is honored
 *   for parity with non-ACP invocations.
 * @property {string[]} [extraArgs] Pass-through args appended verbatim. Use
 *   for flags this declaration hasn't enumerated yet.
 *
 * @typedef {object} BackendDeclaration
 * @property {string} name
 * @property {string} defaultModel
 * @property {ReadonlyMap<string, string>} modelAliases
 * @property {{
 *   cli: (config?: BackendConfig) => ClientTransport
 * }} transports
 * @property {"cli"} defaultTransport
 * @property {{ authCommand: string, envVar: string }} setupHints
 */

/**
 * @type {ReadonlyMap<string, string>}
 */
const MODEL_ALIASES = new Map([
  // Auto-routing aliases — recommended for users.
  ["auto-gemini-3", "auto-gemini-3"],
  ["auto-gemini-2.5", "auto-gemini-2.5"],
  // Short aliases.
  ["pro", "gemini-3.1-pro-preview"],
  ["flash", "gemini-3-flash-preview"],
  ["flash-lite", "gemini-3.1-flash-lite-preview"],
  // Gemini 3.x concrete IDs.
  ["gemini-3.1-pro-preview", "gemini-3.1-pro-preview"],
  ["gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite-preview"],
  ["gemini-3-pro-preview", "gemini-3-pro-preview"],
  ["gemini-3-flash-preview", "gemini-3-flash-preview"],
  // Gemini 2.5 concrete IDs.
  ["gemini-2.5-pro", "gemini-2.5-pro"],
  ["gemini-2.5-flash", "gemini-2.5-flash"],
  ["gemini-2.5-flash-lite", "gemini-2.5-flash-lite"]
]);

/**
 * Build the Gemini CLI argv from launch optimization knobs. Always starts
 * with `--acp` (the runtime always uses ACP mode) and appends the optional
 * launch-time options in a stable order. Mutually-exclusive flags are
 * resolved with explicit options winning over implicit ones (e.g. an
 * explicit `approvalMode` beats `yolo`).
 *
 * Pure function — directly testable; no side effects.
 *
 * @param {BackendConfig} [config]
 * @returns {string[]}
 */
export function buildGeminiArgs(config = {}) {
  const args = ["--acp"];
  if (config.approvalMode) {
    args.push("--approval-mode", config.approvalMode);
  } else if (config.yolo) {
    args.push("--yolo");
  }
  if (config.worktree) args.push("--worktree", config.worktree);
  if (config.sandbox) args.push("--sandbox");
  if (config.model) args.push("--model", config.model);
  if (config.includeDirectories?.length) {
    args.push("--include-directories", config.includeDirectories.join(","));
  }
  for (const policy of config.policyFiles ?? []) {
    args.push("--policy", policy);
  }
  for (const policy of config.adminPolicyFiles ?? []) {
    args.push("--admin-policy", policy);
  }
  if (config.extraArgs?.length) args.push(...config.extraArgs);
  return args;
}

/** @type {BackendDeclaration} */
export const geminiBackend = {
  name: "gemini",
  defaultModel: "auto-gemini-3",
  modelAliases: MODEL_ALIASES,
  transports: {
    cli(config = {}) {
      // `command`/`args` overrides are a test seam: hermetic tests
      // (e.g. tests/integration/get-gemini-auth-status.test.mjs) point them
      // at `node tests/mocks/gemini-mock.mjs --acp`. When `args` is omitted,
      // the launch options on `BackendConfig` are honored via buildGeminiArgs.
      return createCliTransport({
        command: config.command ?? "gemini",
        args: config.args ?? buildGeminiArgs(config),
        env: config.env,
        cwd: config.cwd
      });
    }
  },
  defaultTransport: "cli",
  setupHints: {
    // User-visible command to trigger interactive auth (typed at the host's
    // shell, not via the plugin).
    authCommand: "!gemini",
    envVar: "GEMINI_API_KEY"
  }
};

/**
 * Resolve a user-visible model alias to its concrete model id. Returns the
 * input unchanged if it's not a known alias — matches the legacy
 * `resolveModel` in `gemini-companion.mjs` so the v2 dispatcher won't
 * silently re-write user-supplied identifiers.
 *
 * @param {string | null | undefined} alias
 * @returns {string}
 */
export function resolveGeminiModel(alias) {
  const key = alias ?? geminiBackend.defaultModel;
  return MODEL_ALIASES.get(key) ?? key;
}
