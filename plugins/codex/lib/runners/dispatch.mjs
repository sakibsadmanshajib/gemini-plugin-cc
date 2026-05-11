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
import { findActiveBroker } from "#lib/transport/broker-probe.mjs";
import { runClaudePrint } from "./claude-print.mjs";
import { runCodexExec } from "./codex-exec.mjs";
import { runViaFacade } from "./facade-dispatch.mjs";
import { runGeminiViaBroker } from "./gemini-broker.mjs";
import { runGeminiPrint } from "./gemini-print.mjs";
import { getStreamingRunner } from "./streaming/registry.mjs";

/**
 * @typedef {import("./claude-print.mjs").RunClaudePrintOptions} RunClaudePrintOptions
 * @typedef {import("./codex-exec.mjs").RunCodexExecOptions} RunCodexExecOptions
 * @typedef {import("./gemini-print.mjs").RunGeminiPrintOptions} RunGeminiPrintOptions
 * @typedef {import("#lib/translate/stream-runner.mjs").TurnResult} TurnResult
 * @typedef {import("#lib/backends/names.mjs").BackendName} BackendName
 */

/**
 * One-shot warning latches — log a fallback message only once per
 * process lifetime so stale state doesn't spam stderr on every dispatch.
 * Subsequent fallbacks are silent.
 */
let warnedBrokerFallback = false;
let warnedFacadeFallback = false;
let warnedStreamingFallback = false;

/**
 * Reset the warning latches. Used by tests that need a fresh dispatcher
 * state to assert each warning fires exactly once. Not part of the
 * public API.
 *
 * @internal
 */
export function _resetBrokerWarningForTest() {
  warnedBrokerFallback = false;
  warnedFacadeFallback = false;
  warnedStreamingFallback = false;
}

/**
 * Dispatch a stateless one-shot turn to the appropriate runner.
 *
 * Special case for GEMINI: probe for an existing `gemini --acp` broker
 * before falling through to the cold-start `runGeminiPrint`. When the
 * probe finds a live, current-uid-owned broker for `options.cwd`, the
 * turn runs via `runGeminiViaBroker` instead — turning a ~5s call into
 * a ~50-500ms call. Probe is non-destructive; broker-connect failures
 * fall back to cold-start with a single one-shot warning.
 *
 * Opt-out: pass `disableBroker: true` on options, OR set
 * `context.dispatch.broker = "disabled"`. The boundary builder
 * translates `--no-broker` and `ARTAGON_DISABLE_BROKER=1` env (legacy)
 * into the context.
 *
 * @param {BackendName} backendName
 * @param {RunClaudePrintOptions | RunCodexExecOptions | RunGeminiPrintOptions} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 *   Per-session config. When supplied, `context.dispatch.*` takes
 *   precedence over the equivalent `options.*` and over the
 *   process-env fallback. `context` is also threaded through to
 *   runners + transport + recorder so observability + cost knobs come
 *   from a single source of truth instead of via env vars.
 * @returns {Promise<TurnResult>}
 */
export function runStatelessTurn(backendName, options, context) {
  // Facade path: when opted in, ALL backends try the facade first. The
  // facade has its own backend dispatch internally; we forward the
  // prompt + model hint and accept its TurnResult. On any error we fall
  // back to the per-backend cold-start (or broker-aware) path.
  if (shouldUseFacade(options, context)) {
    return runWithFacadeFallback(backendName, options, context);
  }
  // Streaming path: opt-in via context.dispatch.streaming === "on",
  // options.useStreaming, or ARTAGON_STREAMING=1. Reuses one CLI
  // subprocess across many turns. Wired for all three backends:
  //   GEMINI → existing `gemini --acp` broker socket
  //   CODEX  → spawned `codex app-server`
  //   CLAUDE → spawned `@agentclientprotocol/claude-agent-acp`
  // Unsupported backends fall back to direct dispatch.
  if (shouldUseStreaming(options, context)) {
    return runWithStreamingFallback(backendName, options, context);
  }
  return runDirect(backendName, options, context);
}

/**
 * Direct dispatch (non-facade path). Each backend's per-runner logic.
 *
 * @param {BackendName} backendName
 * @param {RunClaudePrintOptions | RunCodexExecOptions | RunGeminiPrintOptions} options
 * @returns {Promise<TurnResult>}
 */
function runDirect(backendName, options, context) {
  switch (backendName) {
    case BACKEND_NAMES.CLAUDE:
      return runClaudePrint(/** @type {RunClaudePrintOptions} */ (options), context);
    case BACKEND_NAMES.CODEX:
      return runCodexExec(/** @type {RunCodexExecOptions} */ (options), context);
    case BACKEND_NAMES.GEMINI:
      return runGeminiWithBrokerFallback(
        /** @type {RunGeminiPrintOptions & { disableBroker?: boolean, cwd?: string }} */ (options),
        context
      );
    default:
      return Promise.reject(
        new Error(`runStatelessTurn: unknown backend "${String(backendName)}"`)
      );
  }
}

/**
/**
 * Should the dispatcher route this turn through the facade? Precedence:
 *
 *   context.dispatch.facade === "on"   → opt-in (highest)
 *   context.dispatch.facade === "off"  → veto
 *   options.disableFacade === true     → veto
 *   options.useFacade === true         → opt-in
 *   otherwise                          → no facade
 *
 * `ARTAGON_USE_FACADE=1` env-var dispatch was removed in Phase 4 of
 * the AgentContext refactor — env vars are now read at the boundary
 * (lib/agent-context.mjs::buildAgentContextFromArgv) and translated
 * into `context.dispatch.facade`. Lib code must NOT read
 * `process.env.ARTAGON_*` directly. Enforced by
 * `scripts/no-internal-env.mjs`.
 *
 * @param {any} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 * @returns {boolean}
 */
function shouldUseFacade(options, context) {
  if (context?.dispatch?.facade === "on") return true;
  if (context?.dispatch?.facade === "off") return false;
  if (options?.disableFacade === true) return false;
  return options?.useFacade === true;
}

/**
 * Should the dispatcher route this turn through a streaming runner?
 * Same precedence layering as `shouldUseFacade` — and same Phase 4
 * removal of the `ARTAGON_STREAMING=1` env-var fallback.
 *
 * @param {any} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 * @returns {boolean}
 */
function shouldUseStreaming(options, context) {
  if (context?.dispatch?.streaming === "on") return true;
  if (context?.dispatch?.streaming === "off") return false;
  if (options?.disableStreaming === true) return false;
  return options?.useStreaming === true;
}

/**
 * Try the streaming runner; on no-supported-backend or any error fall
 * back to the direct path. The streaming runner is opt-in and shares
 * the dispatcher's "broken warm path MUST NOT block the turn"
 * invariant.
 *
 * @param {BackendName} backendName
 * @param {RunClaudePrintOptions | RunCodexExecOptions | RunGeminiPrintOptions} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 * @returns {Promise<TurnResult>}
 */
async function runWithStreamingFallback(backendName, options, context) {
  /** @type {any} */
  const opts = options;
  const runner = getStreamingRunner(backendName, {
    cwd: context?.cwd ?? opts.cwd,
    env: context?.env ?? opts.env,
    context
  });
  if (!runner) {
    return runDirect(backendName, options, context);
  }
  try {
    return await runner.runTurn(
      {
        prompt: opts.prompt,
        cwd: context?.cwd ?? opts.cwd,
        env: context?.env ?? opts.env,
        model: context?.model ?? opts.model,
        timeoutMs: context?.timeoutMs ?? opts.timeoutMs,
        signal: opts.signal,
        onUpdate: opts.onUpdate
      },
      context
    );
  } catch (err) {
    if (!warnedStreamingFallback) {
      warnedStreamingFallback = true;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[dispatch] streaming runner failed (${message}); falling back to direct path. ` +
          "Subsequent streaming-fallback events this session will be silent.\n"
      );
    }
    return runDirect(backendName, options, context);
  }
}

/**
 * Try the facade; on any error fall back to the direct path.
 *
 * @param {BackendName} backendName
 * @param {RunClaudePrintOptions | RunCodexExecOptions | RunGeminiPrintOptions} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 * @returns {Promise<TurnResult>}
 */
async function runWithFacadeFallback(backendName, options, context) {
  /** @type {any} */
  const opts = options;
  try {
    return await runViaFacade(
      backendName,
      {
        prompt: opts.prompt,
        cwd: context?.cwd ?? opts.cwd,
        env: context?.env ?? opts.env,
        model: context?.model ?? opts.model,
        timeoutMs: context?.timeoutMs ?? opts.timeoutMs,
        bearerToken: context?.facade?.apiKey ?? opts.bearerToken,
        onUpdate: opts.onUpdate
      },
      context
    );
  } catch (err) {
    if (!warnedFacadeFallback) {
      warnedFacadeFallback = true;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[dispatch] facade call failed (${message}); falling back to direct path. ` +
          "Subsequent facade-fallback events this session will be silent.\n"
      );
    }
    return runDirect(backendName, options, context);
  }
}

/**
 * Probe for a live broker; if found, run via the broker; on any error
 * fall back to the cold-start runner. The fallback is the user-visible
 * invariant — a broken broker MUST NOT prevent the turn from running.
 *
 * Broker-skip precedence (highest → lowest):
 *   context.dispatch.broker === "disabled"
 *   options.disableBroker === true
 *
 * `ARTAGON_DISABLE_BROKER=1` env-var dispatch was removed in Phase 4
 * of the AgentContext refactor — env is read at the boundary
 * (`buildAgentContextFromArgv`) and translated into
 * `context.dispatch.broker`. Lib code must NOT read
 * `process.env.ARTAGON_*` directly.
 *
 * @param {RunGeminiPrintOptions & { disableBroker?: boolean, cwd?: string }} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 * @returns {Promise<TurnResult>}
 */
async function runGeminiWithBrokerFallback(options, context) {
  const disableBroker = context?.dispatch?.broker === "disabled" || options.disableBroker === true;

  if (!disableBroker) {
    const cwd = context?.cwd ?? options.cwd ?? process.cwd();
    const endpoint = findActiveBroker(cwd, context?.env ?? process.env);
    if (endpoint) {
      try {
        return await runGeminiViaBroker(
          {
            endpoint,
            prompt: options.prompt,
            cwd,
            env: context?.env ?? options.env,
            model: context?.model ?? options.model,
            approvalMode: options.approvalMode,
            signal: options.signal,
            timeoutMs: context?.timeoutMs ?? options.timeoutMs,
            onUpdate: options.onUpdate
          },
          context
        );
      } catch (err) {
        if (!warnedBrokerFallback) {
          warnedBrokerFallback = true;
          const message = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[dispatch] broker connect failed (${message}); falling back to cold-start. ` +
              "Subsequent broker-fallback events this session will be silent.\n"
          );
        }
      }
    }
  }

  return runGeminiPrint(/** @type {RunGeminiPrintOptions} */ (options), context);
}
