/**
 * Stateless runner dispatcher — single entry point for "give me a one-shot
 * turn from backend X".
 *
 * Step 5 of the unified-facade plan deleted the cold-start runners
 * (`runClaudePrint`, `runCodexExec`, `runGeminiPrint`) and the
 * broker-fallback machinery. All three backends now route through
 * EITHER the streaming runner (owns its CLI subprocess; long-lived)
 * OR the facade (HTTP client to `artagon-openai-server`). There is no
 * cold-start path.
 *
 * Dispatch rules:
 *   1. context.dispatch.facade === "on"  → facade (HTTP)
 *   2. otherwise                          → streaming runner (default)
 *
 * Both paths honor `context.session` (the streaming runner directly,
 * the facade by forwarding X-Artagon-Session / X-Artagon-New-Session
 * headers to the daemon).
 *
 * Why no fallback chain:
 *   - The old fallback (`streaming fails → cold-start`, `broker fails
 *     → cold-start`) traded warm-path latency for "always succeed".
 *     With cold-start gone, an auth or spawn failure surfaces as a
 *     real error instead of being silently masked. Operators see
 *     "claude login expired" instead of a degraded response that
 *     happens to work because the cold path used a different code
 *     path.
 *   - The facade has its own internal dispatch (which uses streaming
 *     runners on the daemon side). A facade error means the daemon
 *     is misconfigured / down; falling back to direct streaming in
 *     the slash-command process defeats the daemon's purpose. The
 *     dispatcher returns the facade error to the caller.
 */

import { BACKEND_NAMES } from "#lib/backends/names.mjs";

import { runViaFacade } from "./facade-dispatch.mjs";
import { getStreamingRunner } from "./streaming/registry.mjs";

/**
 * @typedef {import("#lib/translate/stream-runner.mjs").TurnResult} TurnResult
 * @typedef {import("#lib/backends/names.mjs").BackendName} BackendName
 */

/**
 * @typedef {{
 *   prompt: string,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   model?: string,
 *   timeoutMs?: number,
 *   signal?: AbortSignal,
 *   bearerToken?: string,
 *   onUpdate?: (u: import("#lib/translate/stream-runner.mjs").SessionUpdate) => void,
 *   useStreaming?: boolean,
 *   disableStreaming?: boolean,
 *   useFacade?: boolean,
 *   disableFacade?: boolean,
 * }} RunStatelessTurnOptions
 */

/**
 * Reset the warning latches. Used by tests that need a fresh dispatcher
 * state to assert each warning fires exactly once. Not part of the
 * public API. After Step 5 there are no fallback warnings; the function
 * remains a no-op for callers that still import it.
 *
 * @internal
 */
export function _resetBrokerWarningForTest() {
  // intentionally empty — no fallback warnings exist post-Step 5
}

/**
 * Dispatch a stateless one-shot turn to the appropriate runner.
 *
 * @param {BackendName} backendName
 * @param {RunStatelessTurnOptions} options
 *   Per-turn options: prompt, signal, onUpdate, bearerToken, and (for
 *   transitional callers) cwd / env / model / timeoutMs. The latter
 *   four are ALSO present on `context` — see precedence below.
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 *   Per-session config. `context.cwd / env / model / timeoutMs`
 *   override the equivalent option fields when both are set.
 *   `context.dispatch.facade === "on"` routes through the facade;
 *   anything else uses the streaming runner.
 * @returns {Promise<TurnResult>}
 */
export function runStatelessTurn(backendName, options, context) {
  if (shouldUseFacade(options, context)) {
    return runFacade(backendName, options, context);
  }
  return runStreaming(backendName, options, context);
}

/**
 * @param {any} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 */
function shouldUseFacade(options, context) {
  if (context?.dispatch?.facade === "on") return true;
  if (context?.dispatch?.facade === "off") return false;
  if (options?.disableFacade === true) return false;
  return options?.useFacade === true;
}

/**
 * @param {BackendName} backendName
 * @param {RunStatelessTurnOptions} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 * @returns {Promise<TurnResult>}
 */
async function runStreaming(backendName, options, context) {
  const runner = getStreamingRunner(backendName, {
    cwd: context?.cwd ?? options.cwd,
    env: context?.env ?? options.env,
    context
  });
  if (!runner) {
    throw new Error(
      `runStatelessTurn: unknown backend "${String(backendName)}" — ` +
        `expected one of ${Object.values(BACKEND_NAMES).join(", ")}`
    );
  }
  return runner.runTurn(
    {
      prompt: options.prompt,
      cwd: context?.cwd ?? options.cwd,
      env: context?.env ?? options.env,
      model: context?.model ?? options.model,
      timeoutMs: context?.timeoutMs ?? options.timeoutMs,
      signal: options.signal,
      onUpdate: options.onUpdate
    },
    context
  );
}

/**
 * @param {BackendName} backendName
 * @param {RunStatelessTurnOptions} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 * @returns {Promise<TurnResult>}
 */
async function runFacade(backendName, options, context) {
  return runViaFacade(
    backendName,
    {
      prompt: options.prompt,
      cwd: context?.cwd ?? options.cwd,
      env: context?.env ?? options.env,
      model: context?.model ?? options.model,
      timeoutMs: context?.timeoutMs ?? options.timeoutMs,
      bearerToken: context?.facade?.apiKey ?? options.bearerToken,
      onUpdate: options.onUpdate
    },
    context
  );
}
