/**
 * Codex one-shot runner — spawns `codex exec --json <prompt>`, accumulates
 * the stream into a TurnResult, returns when the CLI exits.
 *
 * Sibling of `runClaudePrint` for codex's stateless execution mode.
 * Where `codexBackend.transports.cli` (acp mode) is the long-running
 * primary path, this runner is the bypass for one-shot invocations: no
 * ACP broker, no in-band session lifecycle, just spawn-and-stream.
 *
 * The argv shape per `docs/cli-options-research.md`:
 *
 *   codex exec --json [--model <id>] [--effort <level>] [--profile <p>]
 *              [-c key=value ...] [--quiet] [extraArgs...] <prompt>
 *
 * `--effort` lives on `exec` (and certain other subcommands), not at the
 * top level — the runner emits it unconditionally when set; if the
 * running codex version doesn't accept it, the subprocess exits non-zero
 * and the rejection carries `{exitCode, stderr}` so the caller can
 * surface the error.
 *
 * Lifecycle (mirrors runClaudePrint):
 *   - spawn fails (ENOENT etc.) → rejects with the spawn error
 *   - child exits 0 with no `turn.completed` → resolves with partial turn
 *   - child exits non-zero → rejects with `{exitCode, stderr}`
 *   - SIGTERM-on-cancel via AbortSignal
 */

import { spawn } from "node:child_process";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { appendCostRecord, normalizeUsage } from "#lib/cost/recorder.mjs";
import { deregisterRunner, registerRunner } from "#lib/runners/orphan-check.mjs";
import { translateCodexStreamEvent } from "#lib/translate/codex-stream.mjs";
import { consumeStreamJson } from "#lib/translate/stream-runner.mjs";

/**
 * @typedef {{
 *   prompt: string,
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   command?: string,
 *   model?: string,
 *   effort?: "low" | "medium" | "high" | "max",
 *   profile?: string,
 *   configOverrides?: Record<string, string>,
 *   quiet?: boolean,
 *   extraArgs?: string[],
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   onUpdate?: (u: import("#lib/translate/stream-runner.mjs").SessionUpdate) => void,
 *   _argsOverride?: string[]
 * }} RunCodexExecOptions
 *
 * `onUpdate` fires once per accumulated `session/update` notification as
 * the codex CLI emits events; used by the OpenAI facade for streaming.
 *
 * `_argsOverride` is a test seam: when set, completely replaces the args
 * (skips the canonical `exec --json ... <prompt>` build). Used by hermetic
 * tests that spawn `node -e <script>` instead of the real codex binary.
 *
 * `timeoutMs` defensive bound — SIGTERM the child + reject after N ms if
 * the CLI hasn't resolved. Distinct from `signal` (caller-driven); both
 * may be set, whichever fires first wins.
 *
 * @typedef {import("#lib/translate/stream-runner.mjs").TurnResult} TurnResult
 */

/**
 * Build the codex exec argv from the optimization knobs.
 *
 * @param {RunCodexExecOptions} options
 * @returns {string[]}
 */
export function buildCodexExecArgs(options) {
  const args = ["exec", "--json"];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.profile) args.push("--profile", options.profile);
  if (options.configOverrides) {
    for (const [k, v] of Object.entries(options.configOverrides)) {
      args.push("-c", `${k}=${v}`);
    }
  }
  if (options.quiet) args.push("--quiet");
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  // Prompt is positional, must come last so flag parsing doesn't swallow
  // it on edge-case prompts that start with `-`.
  args.push(options.prompt);
  return args;
}

/**
 * Run a single codex exec turn and return the accumulated TurnResult.
 *
 * @param {RunCodexExecOptions} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [_context]
 *   Phase 2: accepts AgentContext for forward compat; today the runner
 *   still uses env-var defaults internally. Phase 4 will route the
 *   transport + recorder through `context`.
 * @returns {Promise<TurnResult>}
 */
// eslint-disable-next-line no-unused-vars -- `_context` reserved for Phase 4
export function runCodexExec(options, _context) {
  const { prompt, signal, timeoutMs, onUpdate, _argsOverride, ...rest } = options;
  if (!prompt) {
    return Promise.reject(new Error("runCodexExec: prompt is required"));
  }

  const args = _argsOverride ?? buildCodexExecArgs(options);

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
      try {
        const turnLike = !isError ? /** @type {TurnResult} */ (value) : null;
        appendCostRecord({
          backend: BACKEND_NAMES.CODEX,
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
    const command = rest.command ?? "codex";
    try {
      child = spawn(command, args, {
        cwd: rest.cwd,
        env: rest.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      return settle(/** @type {Error} */ (err), true);
    }

    // Close stdin immediately. The prompt is already passed positionally;
    // leaving stdin open makes codex wait indefinitely for additional input
    // (per `codex exec --help`: "If stdin is piped and a prompt is also
    // provided, stdin is appended as a <stdin> block"). Without an explicit
    // end(), the parent never closes the pipe and codex hangs until the
    // outer timeout fires.
    child.stdin?.end();

    child.on("error", (err) => settle(err, true));

    if (typeof child.pid === "number") {
      pidFilePath = registerRunner({
        childPid: child.pid,
        parentPid: process.pid,
        command,
        args,
        runner: BACKEND_NAMES.CODEX
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
        settle(new Error(`runCodexExec: timed out after ${timeoutMs}ms`), true);
      }, timeoutMs);
    }

    const consumePromise = consumeStreamJson(child.stdout, translateCodexStreamEvent, {
      onUpdate
    }).catch((err) => {
      settle(err, true);
      return null;
    });

    child.on("exit", async (code) => {
      const turn = await consumePromise;
      if (resolved) return;
      if (code !== 0 && code !== null) {
        return settle(/** @type {any} */ ({ exitCode: code, stderr: stderrBuffer.trim() }), true);
      }
      if (turn) settle(turn, false);
      else settle(new Error("runCodexExec: child exited before any output"), true);
    });
  });
}
