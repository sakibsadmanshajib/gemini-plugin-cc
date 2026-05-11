/**
 * Gemini stateless runner — `gemini -p <prompt> -o stream-json`.
 *
 * Sibling of `runClaudePrint` and `runCodexExec`. Where the gemini
 * runtime's primary path is `--acp` mode (long-running, broker-shared,
 * driven by `runAcpPrompt`), this runner is the bypass for one-shot
 * invocations that don't need session reuse — the same shape as
 * runClaudePrint and runCodexExec so `runStatelessTurn` can dispatch
 * to all three uniformly.
 *
 * Argv: `gemini -p <prompt> -o stream-json [--approval-mode <mode>]
 * [--model <id>] [--yolo] [--include-directories <dirs>] [extraArgs...]`
 *
 * The translator (`translateGeminiStreamEvent`) is mostly pass-through;
 * gemini's stream-json event names already match ACP `session/update`
 * kinds. The translator handles JSON-RPC envelope unwrapping and drops
 * non-ACP kinds like `file_change` (which doesn't have a target in the
 * TurnResult accumulator).
 *
 * Lifecycle (mirrors runClaudePrint exactly):
 *   - spawn ENOENT → reject with the spawn error
 *   - non-zero exit → `{exitCode, stderr}`
 *   - AbortSignal → SIGTERM + reject with the abort reason
 *   - timeoutMs → SIGTERM + reject with timeout error
 *   - happy path → race-free await on consumePromise inside the exit
 *     handler so the accumulated turn isn't lost between stdout.close
 *     and child.exit
 */

import { spawn } from "node:child_process";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { appendCostRecord, normalizeUsage } from "#lib/cost/recorder.mjs";
import { deregisterRunner, registerRunner } from "#lib/runners/orphan-check.mjs";
import { translateGeminiStreamEvent } from "#lib/translate/gemini-stream.mjs";
import { consumeStreamJson } from "#lib/translate/stream-runner.mjs";

/**
 * @typedef {{
 *   prompt: string,
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   command?: string,
 *   model?: string,
 *   approvalMode?: "default" | "auto_edit" | "yolo" | "plan",
 *   yolo?: boolean,
 *   includeDirectories?: string[],
 *   extraArgs?: string[],
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   onUpdate?: (u: import("#lib/translate/stream-runner.mjs").SessionUpdate) => void,
 *   _argsOverride?: string[]
 * }} RunGeminiPrintOptions
 *
 * `onUpdate` fires once per accumulated session/update; used by the
 * OpenAI facade for streaming.
 *
 * @typedef {import("#lib/translate/stream-runner.mjs").TurnResult} TurnResult
 */

/**
 * Build the canonical gemini argv for stateless one-shot invocations.
 *
 * @param {RunGeminiPrintOptions} options
 * @returns {string[]}
 */
export function buildGeminiPrintArgs(options) {
  const args = ["-o", "stream-json"];
  if (options.approvalMode) {
    args.push("--approval-mode", options.approvalMode);
  } else if (options.yolo) {
    args.push("--yolo");
  }
  if (options.model) args.push("-m", options.model);
  if (options.includeDirectories?.length) {
    args.push("--include-directories", options.includeDirectories.join(","));
  }
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  // `-p <prompt>` lands last so prompts that look like flags don't get
  // re-interpreted.
  args.push("-p", options.prompt);
  return args;
}

/**
 * Run a single gemini -p turn and return the accumulated TurnResult.
 *
 * @param {RunGeminiPrintOptions} options
 * @param {import("#lib/agent-context.mjs").AgentContext} [_context]
 *   Phase 2: accepts AgentContext for forward compat; today the runner
 *   still uses env-var defaults internally. Phase 4 will route the
 *   transport + recorder through `context`.
 * @returns {Promise<TurnResult>}
 */
// eslint-disable-next-line no-unused-vars -- `_context` reserved for Phase 4
export function runGeminiPrint(options, _context) {
  const { prompt, signal, timeoutMs, onUpdate, _argsOverride, ...rest } = options;
  if (!prompt) {
    return Promise.reject(new Error("runGeminiPrint: prompt is required"));
  }

  const args = _argsOverride ?? buildGeminiPrintArgs(options);

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
          backend: BACKEND_NAMES.GEMINI,
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
    const command = rest.command ?? "gemini";
    try {
      child = spawn(command, args, {
        cwd: rest.cwd,
        env: rest.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (err) {
      return settle(/** @type {Error} */ (err), true);
    }

    child.on("error", (err) => settle(err, true));

    if (typeof child.pid === "number") {
      pidFilePath = registerRunner({
        childPid: child.pid,
        parentPid: process.pid,
        command,
        args,
        runner: BACKEND_NAMES.GEMINI
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
        settle(new Error(`runGeminiPrint: timed out after ${timeoutMs}ms`), true);
      }, timeoutMs);
    }

    const consumePromise = consumeStreamJson(child.stdout, translateGeminiStreamEvent, {
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
      else settle(new Error("runGeminiPrint: child exited before any output"), true);
    });
  });
}
