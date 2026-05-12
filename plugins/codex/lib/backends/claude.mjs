/**
 * Claude backend declaration — CLI-only.
 *
 * Per the CLI-only architecture, the Claude backend launches the `claude`
 * binary. Anthropic's Claude CLI does not (yet) ship an ACP mode; this
 * factory therefore returns a transport that surfaces an actionable error
 * on `start()` rather than blowing up later in the request pipeline.
 *
 * The factory remains in place for parity with codex/gemini so the
 * multi-backend dispatcher can iterate the three backends uniformly. When
 * Claude CLI ships ACP support, this factory swaps in a real
 * `createCliTransport({ command: "claude", args: [...] })` invocation and
 * the surrounding architecture is unchanged.
 *
 * CLI-specific optimization options (preserved as accepted-but-stored
 * config so the eventual swap doesn't change the call-site signature):
 *   - `model`: per-invocation model id (e.g. "sonnet", "opus", "haiku").
 *   - `permissionMode`: `"default" | "acceptEdits" | "bypassPermissions"`.
 *   - `extraArgs`: pass-through CLI flags.
 */

/**
 * @typedef {import("../acp/client.mjs").ClientTransport} ClientTransport
 * @typedef {import("../acp/types.mjs").HealthState} HealthState
 *
 * @typedef {object} ClaudeBackendConfig
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [cwd]
 * @property {string} [command] Override for the spawned binary (test seam, parity with codex/gemini).
 *
 * --- Operation mode (mutually exclusive; pick one) ---
 *
 * @property {boolean} [print] `--print`/`-p`: stateless one-shot. Implies
 *   non-interactive output. Required for any `--output-format` other than text.
 * @property {boolean} [continue] `--continue`/`-c`: continue most recent
 *   conversation in cwd. Mutually exclusive with `resume`/`sessionId`.
 * @property {string | true} [resume] `--resume <id>` or `--resume` (picker).
 *   `true` opens the picker; a string targets a specific session id.
 *
 * --- Session identity ---
 *
 * @property {string} [sessionId] `--session-id <uuid>`: explicit session UUID.
 *   If new, Claude creates the session; if existing, joins it. Claude is the
 *   only one of the three CLIs with a true spawn-time session id.
 * @property {boolean} [forkSession] `--fork-session`: when resuming, create
 *   a new session id instead of reusing. Use with `resume` or `continue`.
 * @property {boolean} [noSessionPersistence] `--no-session-persistence`:
 *   disable saving (only valid with `print: true`).
 *
 * --- Model + cost knobs ---
 *
 * @property {string} [model] `--model <alias-or-id>`.
 * @property {string} [fallbackModel] `--fallback-model <id>`: only with `print`.
 * @property {"low" | "medium" | "high" | "xhigh" | "max"} [effort]
 *   `--effort <level>`. Note `xhigh` is unique to Claude (codex/gemini don't have it).
 * @property {number} [maxBudgetUsd] `--max-budget-usd <amount>`: only with `print`.
 *
 * --- Permission + tool surface ---
 *
 * @property {"default" | "acceptEdits" | "auto" | "bypassPermissions" | "dontAsk" | "plan"} [permissionMode]
 *   `--permission-mode <mode>`.
 * @property {string[]} [allowedTools] `--allowedTools <tools...>`.
 * @property {string[]} [disallowedTools] `--disallowedTools <tools...>`.
 *
 * --- I/O format ---
 *
 * @property {"text" | "json" | "stream-json"} [outputFormat]
 *   `--output-format <format>`: only with `print`.
 * @property {"text" | "stream-json"} [inputFormat]
 *   `--input-format <format>`: only with `print`.
 * @property {boolean} [includePartialMessages]
 * @property {boolean} [includeHookEvents]
 * @property {boolean} [verbose] `--verbose`: required when combining
 *   `--print` with `--output-format=stream-json` (claude rejects the
 *   pair otherwise: "When using --print, --output-format=stream-json
 *   requires --verbose"). Caller should pass `verbose: true` whenever
 *   they request stream-json output.
 * @property {boolean} [bare] `--bare`: minimal mode.
 *
 * --- Misc ---
 *
 * @property {string} [name] `--name <display>`: human-readable label.
 * @property {string[]} [addDir] `--add-dir <dirs...>`.
 * @property {string} [systemPrompt] `--system-prompt <prompt>`.
 * @property {string} [appendSystemPrompt] `--append-system-prompt <prompt>`.
 * @property {string[]} [extraArgs] Pass-through; appended last.
 *
 * @typedef {object} ClaudeBackendDeclaration
 * @property {string} name
 * @property {string} defaultModel
 * @property {ReadonlyMap<string, string>} modelAliases
 * @property {{ cli: (config?: ClaudeBackendConfig) => ClientTransport }} transports
 * @property {"cli"} defaultTransport
 * @property {{ authCommand: string, envVar: string }} setupHints
 */

/**
 * Claude model aliases — verified against the Anthropic SDK's Model
 * union type (anthropics/anthropic-sdk-python/src/anthropic/types/model.py)
 * retrieved via context7 on 2026-05-12. Current canonical IDs:
 *   - claude-opus-4-7        (latest opus — what this session runs on)
 *   - claude-opus-4-6
 *   - claude-sonnet-4-6
 *   - claude-haiku-4-5       (claude-haiku-4-5-20251001 pinned)
 *
 * Opus 4.7 1M-context: the SDK does NOT define a separate
 * `claude-opus-4-7-1m` model ID. The 1M extended-context window is
 * a billing tier toggled by the `context-1m-2025-08-07` anthropic-beta
 * header on a regular `claude-opus-4-7` request. We expose `opus-1m`
 * and `claude-opus-4-7-1m` as routing aliases so callers can request
 * the 1M window by name; the claude-agent-acp runner (or any future
 * adapter that talks directly to the Anthropic API) is responsible for
 * setting the beta header when the resolved alias ends in `-1m`.
 *
 * @type {ReadonlyMap<string, string>}
 */
const MODEL_ALIASES = new Map([
  ["sonnet", "claude-sonnet-4-6"],
  ["opus", "claude-opus-4-7"],
  ["opus-1m", "claude-opus-4-7-1m"],
  ["haiku", "claude-haiku-4-5"],
  ["claude-sonnet-4-6", "claude-sonnet-4-6"],
  ["claude-opus-4-7", "claude-opus-4-7"],
  ["claude-opus-4-7-1m", "claude-opus-4-7-1m"],
  ["claude-haiku-4-5", "claude-haiku-4-5"]
]);

const NOT_YET_SUPPORTED_MESSAGE =
  "Claude CLI does not yet support ACP mode. The Claude backend is declared for parity with " +
  "codex/gemini but is not callable until upstream ships ACP support.";

/**
 * Build the Claude CLI argv from a ClaudeBackendConfig per
 * `docs/cli-options-research.md`. Pure function — exported so callers and
 * tests can verify argv emission without spawning a subprocess.
 *
 * Validation: `noSessionPersistence`, `outputFormat` (non-text),
 * `inputFormat`, `fallbackModel`, `maxBudgetUsd`, `includePartialMessages`,
 * and `includeHookEvents` are all `--print`-only per Claude's help. If
 * `print` isn't set but a print-only option is, this function THROWS rather
 * than silently dropping the option — matches the project's no-silent-fallback
 * posture from `lib/middleware/`.
 *
 * Resume/continue/sessionId interaction:
 *   - `continue` and `resume` are mutually exclusive (Claude rejects both).
 *   - `sessionId` is independent: it can stand alone (create-or-join the
 *     specific UUID) OR combine with `forkSession` to fork a resumed session.
 *
 * @param {ClaudeBackendConfig} [config]
 * @returns {string[]}
 */
export function buildClaudeArgs(config = {}) {
  const printOnly = [];
  if (config.noSessionPersistence) printOnly.push("noSessionPersistence");
  if (config.outputFormat && config.outputFormat !== "text") printOnly.push("outputFormat");
  if (config.inputFormat) printOnly.push("inputFormat");
  if (config.fallbackModel) printOnly.push("fallbackModel");
  if (typeof config.maxBudgetUsd === "number") printOnly.push("maxBudgetUsd");
  if (config.includePartialMessages) printOnly.push("includePartialMessages");
  if (config.includeHookEvents) printOnly.push("includeHookEvents");
  if (printOnly.length && !config.print) {
    throw new Error(
      `buildClaudeArgs: ${printOnly.join(", ")} require print: true (per claude --help)`
    );
  }
  if (config.continue && config.resume !== undefined) {
    throw new Error("buildClaudeArgs: continue and resume are mutually exclusive");
  }

  const args = [];
  if (config.print) args.push("--print");
  if (config.continue) args.push("--continue");
  if (config.resume === true) args.push("--resume");
  else if (typeof config.resume === "string") args.push("--resume", config.resume);
  if (config.sessionId) args.push("--session-id", config.sessionId);
  if (config.forkSession) args.push("--fork-session");
  if (config.bare) args.push("--bare");
  if (config.name) args.push("--name", config.name);
  if (config.model) args.push("--model", config.model);
  if (config.fallbackModel) args.push("--fallback-model", config.fallbackModel);
  if (config.effort) args.push("--effort", config.effort);
  if (typeof config.maxBudgetUsd === "number") {
    args.push("--max-budget-usd", String(config.maxBudgetUsd));
  }
  if (config.permissionMode) args.push("--permission-mode", config.permissionMode);
  if (config.allowedTools?.length) args.push("--allowedTools", ...config.allowedTools);
  if (config.disallowedTools?.length) args.push("--disallowedTools", ...config.disallowedTools);
  if (config.addDir?.length) args.push("--add-dir", ...config.addDir);
  if (config.systemPrompt) args.push("--system-prompt", config.systemPrompt);
  if (config.appendSystemPrompt) args.push("--append-system-prompt", config.appendSystemPrompt);
  if (config.outputFormat) args.push("--output-format", config.outputFormat);
  if (config.inputFormat) args.push("--input-format", config.inputFormat);
  if (config.includePartialMessages) args.push("--include-partial-messages");
  if (config.includeHookEvents) args.push("--include-hook-events");
  if (config.verbose) args.push("--verbose");
  if (config.noSessionPersistence) args.push("--no-session-persistence");
  if (config.extraArgs?.length) args.push(...config.extraArgs);
  return args;
}

/**
 * Build a placeholder transport that fails on `start()` with an actionable
 * error. Returns a fully-typed `ClientTransport` so consumers needn't
 * special-case the "not yet supported" path.
 *
 * @param {ClaudeBackendConfig} _config — accepted for forward compatibility.
 * @returns {ClientTransport}
 */
function createNotYetSupportedTransport(_config) {
  return {
    async start() {
      throw new Error(NOT_YET_SUPPORTED_MESSAGE);
    },
    send() {
      throw new Error(NOT_YET_SUPPORTED_MESSAGE);
    },
    onMessage() {},
    onHealthChange() {},
    healthState: () => /** @type {HealthState} */ ("queued"),
    async close() {},
    isOpen: () => false
  };
}

/** @type {ClaudeBackendDeclaration} */
export const claudeBackend = {
  name: "claude",
  defaultModel: "sonnet",
  modelAliases: MODEL_ALIASES,
  transports: {
    cli(config = {}) {
      return createNotYetSupportedTransport(config);
    }
  },
  defaultTransport: "cli",
  setupHints: {
    authCommand: "claude /login",
    envVar: "ANTHROPIC_API_KEY"
  }
};

/**
 * Resolve a user-visible alias to its concrete model id. Unknown aliases
 * pass through unchanged (matches geminiBackend / codexBackend contract).
 *
 * @param {string | null | undefined} alias
 * @returns {string}
 */
export function resolveClaudeModel(alias) {
  const key = alias ?? claudeBackend.defaultModel;
  return MODEL_ALIASES.get(key) ?? key;
}
