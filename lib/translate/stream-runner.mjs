/**
 * Stream-json turn runner — reads one CLI-style stream-json conversation
 * from a Readable, translates each line via a caller-supplied translator,
 * and accumulates a TurnResult.
 *
 * This is the bridge between `lib/translate/{codex,claude}-stream.mjs`
 * (pure event-shape translators) and a real subprocess invocation. It
 * deliberately doesn't spawn — callers pass already-wired streams (or
 * PassThroughs in tests). That keeps this module pure-ish and easily
 * testable; the spawn/lifecycle wrapping lives one layer up where each
 * backend's CLI-specific args + env handling matter.
 *
 * Wire model:
 *   - Caller writes the prompt envelope(s) to `stdin` (the stream-json
 *     input format expected by the CLI). This module DOES NOT format the
 *     prompt — the caller knows the per-CLI input shape.
 *   - This module reads `stdout` line-by-line, runs each line through
 *     `translator`, and accumulates the resulting ACP `session/update`
 *     notifications into a TurnResult.
 *   - Resolution: when the translator emits a `turn_completed` update, OR
 *     when stdout ends (EOF), whichever happens first.
 *
 * The translator may return null (drift signal), a single SessionUpdate,
 * or an array of SessionUpdates per line (Claude's translator returns
 * arrays; Codex's returns single).
 */

import readline from "node:readline";

/**
 * @typedef {{
 *   sessionUpdate: string,
 *   content?: { text: string },
 *   toolName?: string,
 *   toolUseId?: string,
 *   args?: any,
 *   result?: any,
 *   isError?: boolean,
 *   reason?: string,
 *   usage?: any
 * }} SessionUpdate
 *
 * @typedef {(event: any) => SessionUpdate | SessionUpdate[] | null} StreamTranslator
 *
 * @typedef {{
 *   text: string,
 *   thoughtText: string,
 *   chunkCount: number,
 *   chunkChars: number,
 *   thoughtCount: number,
 *   thoughtChars: number,
 *   toolCalls: Array<{ toolName: string, toolUseId: string, args: any }>,
 *   toolResults: Array<{ toolUseId: string, result: any, isError: boolean }>,
 *   usage: any | null,
 *   reason: string | null,
 *   updates: SessionUpdate[]
 * }} TurnResult
 *
 * @typedef {{
 *   onUpdate?: (u: SessionUpdate) => void,
 *   onUnknownEvent?: (raw: unknown) => void,
 *   onMalformedLine?: (line: string, err: Error) => void
 * }} StreamRunnerOptions
 */

/**
 * Drive a stream-json turn to completion.
 *
 * @param {NodeJS.ReadableStream} stdout — line-delimited JSON events.
 * @param {StreamTranslator} translator — per-CLI event translator.
 * @param {StreamRunnerOptions} [options]
 * @returns {Promise<TurnResult>}
 */
export function consumeStreamJson(stdout, translator, options = {}) {
  /** @type {TurnResult} */
  const turn = {
    text: "",
    thoughtText: "",
    chunkCount: 0,
    chunkChars: 0,
    thoughtCount: 0,
    thoughtChars: 0,
    toolCalls: [],
    toolResults: [],
    usage: null,
    reason: null,
    updates: []
  };

  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: stdout });
    let resolved = false;

    /**
     * @param {SessionUpdate} update
     */
    function applyUpdate(update) {
      turn.updates.push(update);
      options.onUpdate?.(update);

      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = update.content?.text ?? "";
          turn.text += text;
          turn.chunkCount += 1;
          turn.chunkChars += text.length;
          break;
        }
        case "agent_thought_chunk": {
          const text = update.content?.text ?? "";
          turn.thoughtText += text;
          turn.thoughtCount += 1;
          turn.thoughtChars += text.length;
          break;
        }
        case "tool_call":
          turn.toolCalls.push({
            toolName: update.toolName ?? "unknown",
            toolUseId: update.toolUseId ?? "",
            args: update.args ?? {}
          });
          break;
        case "tool_result":
          turn.toolResults.push({
            toolUseId: update.toolUseId ?? "",
            result: update.result,
            isError: Boolean(update.isError)
          });
          break;
        case "turn_completed":
          turn.usage = update.usage ?? null;
          turn.reason = update.reason ?? null;
          if (!resolved) {
            resolved = true;
            rl.close();
            resolve(turn);
          }
          break;
        default:
          // Unknown sessionUpdate kind — translator emitted something we
          // don't recognize. Keep it in updates[] but don't accumulate.
          break;
      }
    }

    rl.on("line", (line) => {
      if (!line.trim()) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        options.onMalformedLine?.(line, /** @type {Error} */ (err));
        return;
      }
      // Translator throws (e.g. on a shape the implementation didn't
      // anticipate) used to propagate as an unhandled readline error,
      // hanging the consumePromise and blocking the runner until
      // timeoutMs. Catch + route through onMalformedLine so the runner
      // can settle cleanly instead.
      let result;
      try {
        result = translator(parsed);
      } catch (err) {
        options.onMalformedLine?.(line, /** @type {Error} */ (err));
        return;
      }
      if (result == null) {
        options.onUnknownEvent?.(parsed);
        return;
      }
      if (Array.isArray(result)) {
        for (const u of result) applyUpdate(u);
      } else {
        applyUpdate(result);
      }
    });

    rl.on("close", () => {
      // EOF without an explicit turn_completed — resolve with what we have.
      // This is the common case for CLI invocations that end with stdout
      // close rather than a structured terminator (e.g. process killed mid-
      // turn, or the CLI just stops emitting after final result).
      if (!resolved) {
        resolved = true;
        resolve(turn);
      }
    });

    stdout.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        rl.close();
        reject(err);
      }
    });
  });
}
