/**
 * Stateless runner dispatcher — single entry point for "give me a one-shot
 * turn from backend X". Maps a backend name to its runner without callers
 * having to import each runner directly.
 *
 * Why exist:
 *   - Future slash commands need a way to say "run this prompt against
 *     <backend>" without per-backend if/else branching.
 *   - Keeps the runner surface discoverable: `runStatelessTurn` is the
 *     one symbol consumers import.
 *
 * Why NOT a class / registry / plugin system:
 *   - Three backends. The dispatch is a switch. Adding a registry would be
 *     premature abstraction (no fourth backend on the horizon, and even
 *     if there were, switch-statement growth is more honest than registry
 *     fan-out).
 *
 * Gemini has TWO drive paths: the long-running broker-shared `--acp`
 * mode (driven by `runAcpPrompt` from the legacy gemini-plugin) AND
 * the stateless `gemini -p -o stream-json` runner exposed here as
 * `runGeminiPrint`. `runStatelessTurn(BACKEND_NAMES.GEMINI, ...)`
 * routes to the stateless path; for ACP mode use `runAcpPrompt`
 * directly.
 */

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { runClaudePrint } from "./claude-print.mjs";
import { runCodexExec } from "./codex-exec.mjs";
import { runGeminiPrint } from "./gemini-print.mjs";

/**
 * @typedef {import("./claude-print.mjs").RunClaudePrintOptions} RunClaudePrintOptions
 * @typedef {import("./codex-exec.mjs").RunCodexExecOptions} RunCodexExecOptions
 * @typedef {import("./gemini-print.mjs").RunGeminiPrintOptions} RunGeminiPrintOptions
 * @typedef {import("#lib/translate/stream-runner.mjs").TurnResult} TurnResult
 * @typedef {import("#lib/backends/names.mjs").BackendName} BackendName
 */

/**
 * Dispatch a stateless one-shot turn to the appropriate runner.
 *
 * @param {BackendName} backendName
 * @param {RunClaudePrintOptions | RunCodexExecOptions | RunGeminiPrintOptions} options
 * @returns {Promise<TurnResult>}
 */
export function runStatelessTurn(backendName, options) {
  switch (backendName) {
    case BACKEND_NAMES.CLAUDE:
      return runClaudePrint(/** @type {RunClaudePrintOptions} */ (options));
    case BACKEND_NAMES.CODEX:
      return runCodexExec(/** @type {RunCodexExecOptions} */ (options));
    case BACKEND_NAMES.GEMINI:
      return runGeminiPrint(/** @type {RunGeminiPrintOptions} */ (options));
    default:
      return Promise.reject(
        new Error(`runStatelessTurn: unknown backend "${String(backendName)}"`)
      );
  }
}
