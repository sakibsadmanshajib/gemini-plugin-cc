/**
 * Claude one-shot runner — spawns `claude --print --output-format=stream-json`,
 * accumulates the stream into a TurnResult, returns when the CLI exits.
 *
 * This is the closest thing to a working Claude backend until upstream
 * Claude CLI ships ACP mode. The path is:
 *
 *   buildClaudeArgs(config)          ← argv builder (lib/backends/claude.mjs)
 *     │
 *     ▼ spawn `claude` with stream-json output
 *   child.stdout
 *     │
 *     ▼ consumeStreamJson(stdout, translateClaudeStreamEvent)
 *   TurnResult { text, thoughtText, toolCalls, toolResults, usage, reason }
 *
 * The runner forces `print: true` and `outputFormat: "stream-json"` because
 * those are required for the streamed-event path; everything else from
 * `ClaudeBackendConfig` (model, effort, permissionMode, sessionId,
 * resume, etc.) flows through verbatim.
 *
 * Lifecycle:
 *   - spawn fails (ENOENT etc.) → rejects with a wrapped error
 *   - child exits 0 with no `result` event → resolves with partial turn (EOF)
 *   - child exits non-zero → rejects with `{ exitCode, stderr }`
 *   - SIGTERM-on-cancel: caller passes an AbortSignal; on abort we kill
 *     the child and reject with the abort reason.
 */

import { spawn } from "node:child_process";

import { buildClaudeArgs } from "#lib/backends/claude.mjs";
import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { appendCostRecord, normalizeUsage } from "#lib/cost/recorder.mjs";
import { deregisterRunner, registerRunner } from "#lib/runners/orphan-check.mjs";
import { translateClaudeStreamEvent } from "#lib/translate/claude-stream.mjs";
import { consumeStreamJson } from "#lib/translate/stream-runner.mjs";

/**
 * @typedef {import("#lib/backends/claude.mjs").ClaudeBackendConfig & {
 *   prompt: string,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   onUpdate?: (u: import("#lib/translate/stream-runner.mjs").SessionUpdate) => void,
 *   _argsOverride?: string[]
 * }} RunClaudePrintOptions
 *
 * `onUpdate` fires once per accumulated `session/update` notification as
 * the underlying CLI emits events. This is the streaming hook used by
 * the OpenAI facade to push delta chunks to clients in real time. The
 * `TurnResult` returned at the end is the same as without the callback;
 * `onUpdate` is purely additive observation.
 *
 * `timeoutMs` is a defensive bound — if the CLI hasn't resolved before
 * the timer fires, the runner SIGTERMs the child and rejects with a
 * `Error("runClaudePrint: timed out after Nms")`. Distinct from
 * AbortSignal: the timer fires automatically; AbortSignal is
 * caller-driven. Both can be set; whichever fires first wins.
 *
 * `_argsOverride` is a test seam: when set, it completely replaces the
 * args produced by buildClaudeArgs (and skips appending `prompt`). Used
 * by hermetic tests that spawn `node -e <script>` instead of the real
 * claude binary — the override keeps node's argv parser happy by
 * preventing claude flags from leaking to node's command line.
 *
 * @typedef {import("#lib/translate/stream-runner.mjs").TurnResult} TurnResult
 */

/**
 * Run a single Claude print-mode turn and return the accumulated TurnResult.
 *
 * @param {RunClaudePrintOptions} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [_context]
 *   Phase 2: signature accepts an optional AgentContext for forward
 *   compatibility with the boundary builder. Phase 4 will route the
 *   transport's wire-log + cost-record paths through this context;
 *   today the runner still uses env-var defaults internally.
 * @returns {Promise<TurnResult>}
 */
// eslint-disable-next-line no-unused-vars -- `_context` reserved for Phase 4
export function runClaudePrint(options, _context) {
  const { prompt, signal, timeoutMs, onUpdate, _argsOverride, ...rest } = options;
  if (!prompt) {
    return Promise.reject(new Error("runClaudePrint: prompt is required"));
  }

  let args;
  if (_argsOverride) {
    args = _argsOverride;
  } else {
    // Force the streamed-event path. buildClaudeArgs validates the print-only
    // combination, so passing outputFormat without print would throw.
    // `verbose: true` is mandatory: claude rejects `--print --output-format=stream-json`
    // without `--verbose` (claude's runtime check, not ours).
    args = buildClaudeArgs({
      ...rest,
      print: true,
      outputFormat: "stream-json",
      verbose: true
    });
    // The prompt is positional in `claude --print` invocations.
    args.push(prompt);
  }

  return new Promise((resolve, reject) => {
    let stderrBuffer = "";
    let resolved = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;

    /** @type {string | null} */
    let pidFilePath = null;

    const startedAtMs = Date.now();

    /** @param {Error | { exitCode: number, stderr: string } | TurnResult} value @param {boolean} isError */
    function settle(value, isError) {
      if (resolved) return;
      resolved = true;
      if (timer) clearTimeout(timer);
      deregisterRunner(pidFilePath);
      // Append a cost record best-effort. Done inside settle so every
      // termination path (success, exit non-zero, abort, timeout, ENOENT)
      // is captured.
      try {
        const turnLike = !isError ? /** @type {TurnResult} */ (value) : null;
        appendCostRecord({
          backend: BACKEND_NAMES.CLAUDE,
          model: turnLike?.model ?? null,
          promptChars: prompt.length,
          usage: normalizeUsage(turnLike?.usage ?? null),
          durationMs: Date.now() - startedAtMs,
          reason: turnLike?.reason ?? null,
          ok: !isError
        });
      } catch {
        // best-effort
      }
      if (isError) reject(value);
      else resolve(/** @type {TurnResult} */ (value));
    }

    let child;
    const command = rest.command ?? "claude";
    try {
      child = spawn(command, args, {
        cwd: rest.cwd,
        env: rest.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      return settle(/** @type {Error} */ (err), true);
    }

    // Spawn errors (ENOENT, EACCES) arrive asynchronously via 'error'.
    child.on("error", (err) => settle(err, true));

    // Register a per-process pid file at <tmp>/claude-agent-<rand>.pid.
    // Best-effort: failures silently proceed; orphan tracking is
    // observability, not load-bearing for the runner itself.
    if (typeof child.pid === "number") {
      pidFilePath = registerRunner({
        childPid: child.pid,
        parentPid: process.pid,
        command,
        args,
        runner: BACKEND_NAMES.CLAUDE
      });
    }

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      stderrBuffer += chunk;
    });

    if (signal) {
      const onAbort = () => {
        try {
          child.kill("SIGTERM");
        } catch {
          // best-effort
        }
        settle(signal.reason ?? new Error("aborted"), true);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // best-effort
        }
        settle(new Error(`runClaudePrint: timed out after ${timeoutMs}ms`), true);
      }, timeoutMs);
    }

    const consumePromise = consumeStreamJson(child.stdout, translateClaudeStreamEvent, {
      onUpdate
    }).catch((err) => {
      settle(err, true);
      return null;
    });

    child.on("exit", async (code) => {
      // Await consumeStreamJson directly — exit may fire before stdout's
      // 'close' event has been processed; awaiting here is the only
      // race-free way to ensure we have the accumulated turn.
      const turn = await consumePromise;
      if (resolved) return;
      if (code !== 0 && code !== null) {
        return settle(/** @type {any} */ ({ exitCode: code, stderr: stderrBuffer.trim() }), true);
      }
      if (turn) settle(turn, false);
      else settle(new Error("runClaudePrint: child exited before any output"), true);
    });
  });
}
