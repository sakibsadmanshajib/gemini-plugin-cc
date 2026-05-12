/**
 * Shared entry point for slash-command scripts under
 * `plugins/<host>/scripts/<backend>-prompt.mjs`.
 *
 * Each script today is ~60 lines of identical boilerplate: parse argv,
 * print usage, run a turn, print text/toolCalls/usage. This helper
 * collapses them to:
 *
 *   import { BACKEND_NAMES } from "#lib/backends/names.mjs";
 *   import { runSlashCommandScript } from "#lib/cli/script-entry.mjs";
 *
 *   await runSlashCommandScript({
 *     backend: BACKEND_NAMES.CODEX,
 *     scriptName: "codex-prompt"
 *   });
 *
 * Three responsibilities at this boundary:
 *
 *   1. **AgentContext build** — reads CLI argv + env exactly once,
 *      builds a frozen context, and passes that context to
 *      `runStatelessTurn`. Lib code downstream reads from context,
 *      not from env. This is the single place `ARTAGON_*` env vars
 *      are read (Phase 4 of the AgentContext refactor).
 *
 *   2. **Facade auto-start** (Step 4a) — when no live manifest is
 *      present and `context.dispatch.facade !== "off"`, calls
 *      `autoStartFacade` to background-spawn the daemon. The daemon
 *      auto-starts come with the Q4 circuit breaker, T1 tombstone
 *      sweep, and R1 lock-serialized breaker read/append from
 *      `lib/server/auto-start.mjs`. Spawn failure is non-fatal — we
 *      emit a one-line stderr hint and fall through to in-process
 *      streaming.
 *
 *   3. **G6 auto-key resolution** — when the auto-started daemon
 *      uses `--auto-key`, the resulting manifest names the
 *      `autoKey.store` ("file" or "keychain"). For "file" we read
 *      the 0o600 key file directly (no extra consent — same uid)
 *      and inject it into `context.facade.apiKey`. For "keychain"
 *      we emit the retrieve-command hint so the operator can export
 *      `ARTAGON_FACADE_API_KEY` once, instead of getting an opaque
 *      401 on every slash-command.
 *
 * On success: prints `turn.text`, optional tool-calls summary, usage,
 * and the session id (when the runner exposed one). Exits 0/1/2 per
 * the standard bin contract.
 */

import process from "node:process";

import { buildAgentContextFromArgv, withOverrides } from "#lib/agent-context.mjs";
import { formatHelp } from "#lib/cli/flags.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";
import { readFileStore } from "#lib/server/api-key-store.mjs";
import { autoStartFacade } from "#lib/server/auto-start.mjs";
import { readManifest } from "#lib/server/facade-endpoint.mjs";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Drive a single slash-command turn end-to-end. Reads argv, builds a
 * frozen `AgentContext`, dispatches to the right backend, prints the
 * accumulated text + tool-call summary + usage, then exits the
 * process. Designed to be the only line in a slash-command bin.
 *
 * @param {object} opts
 * @param {import("#lib/backends/names.mjs").BackendName} opts.backend
 *   Which backend to dispatch to (CODEX / CLAUDE / GEMINI).
 * @param {string} opts.scriptName
 *   Used for usage / error messages. The slash-command path is
 *   typically e.g. "/codex:prompt" — `scriptName` is the bare script
 *   filename minus the extension.
 * @returns {Promise<never>}
 */
export async function runSlashCommandScript(opts) {
  const { backend, scriptName } = opts;

  let parseResult;
  try {
    parseResult = buildAgentContextFromArgv(process.argv.slice(2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${scriptName}: ${message}\n`);
    return process.exit(2);
  }

  if (parseResult.helpRequested) {
    process.stdout.write(`${formatHelp(scriptName)}\n`);
    return process.exit(0);
  }

  const { context: parsedContext, prompt } = parseResult;

  if (!prompt) {
    process.stderr.write(
      `${scriptName}: usage: ${scriptName} [flags] [--] <prompt>\n` +
        `Try \`${scriptName} --help\` for the full flag list.\n`
    );
    return process.exit(2);
  }

  // Step 4: when an artagon-openai-server manifest is present, default
  // the slash-command to facade=on. The daemon owns the warm streaming
  // supervisors for all three backends; the slash-command becomes a
  // thin HTTP client. Operator opt-out: --no-facade.
  //
  // When no manifest exists, fall through to the previous behavior:
  // streaming=on directly in this process. That keeps the slash-
  // command functional without a daemon (cold-start tax on first call).
  //
  // Step 4a: when no manifest exists AND the user didn't explicitly
  // opt out via --no-facade, auto-start the daemon in the background.
  // proper-lockfile prevents two parallel slash-commands from
  // double-spawning the daemon. On success, autoStartFacade returns
  // the live manifest; on failure (lock timeout, manifest poll
  // timeout) it throws and we fall through to in-process streaming.
  let manifest = readManifest(parsedContext.env);
  if (!manifest && parsedContext.dispatch.facade !== "off") {
    try {
      manifest = await autoStartFacade({ env: parsedContext.env });
    } catch (err) {
      // Failure to auto-start isn't fatal — the slash-command can
      // still run in-process. Emit a one-line stderr hint so the
      // operator knows why latency may be higher than expected.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `${scriptName}: auto-start failed (${message}); running in-process this turn.\n`
      );
    }
  }
  /** @type {{ dispatch?: any, facade?: any }} */
  const overrides = {};
  if (manifest && parsedContext.dispatch.facade === "default") {
    overrides.dispatch = { ...parsedContext.dispatch, facade: "on" };
    // G6: auto-resolve the daemon's API key when it was auto-provisioned.
    //   - store "file":     read the 0o600 key file directly. The user
    //                       owns the file (same uid), so no consent
    //                       needed. The key never appears on argv or
    //                       in `ps` output.
    //   - store "keychain": we can't shell out to `security find-...`
    //                       silently — that would prompt the user
    //                       (or print to the operator's stderr) on
    //                       every slash-command invocation. Emit an
    //                       actionable hint and let the user export
    //                       ARTAGON_FACADE_API_KEY themselves.
    if (!parsedContext.facade.apiKey && manifest.autoKey) {
      if (manifest.autoKey.store === "file") {
        try {
          const key = readFileStore();
          if (key) {
            overrides.facade = { ...parsedContext.facade, apiKey: key };
          }
        } catch {
          // Permissions / IO error: fall through to the auth-fail path.
          // The dispatcher's facade fallback will surface a 401 below.
        }
      } else if (manifest.autoKey.store === "keychain") {
        process.stderr.write(
          `${scriptName}: facade requires an API key. Run:\n` +
            `  ${manifest.autoKey.retrieveCommand}\n` +
            "and set ARTAGON_FACADE_API_KEY to the result before retrying.\n"
        );
      }
    }
  } else if (parsedContext.dispatch.streaming === "default") {
    // No manifest → previous behavior: streaming default-on in this
    // process. Warm path lives ONLY for the duration of this script.
    overrides.dispatch = { ...parsedContext.dispatch, streaming: "on" };
  }
  const context =
    Object.keys(overrides).length > 0 ? withOverrides(parsedContext, overrides) : parsedContext;

  try {
    const turn = await runStatelessTurn(
      backend,
      {
        prompt,
        cwd: context.cwd,
        env: context.env,
        model: context.model,
        timeoutMs: context.timeoutMs ?? DEFAULT_TIMEOUT_MS
      },
      context
    );

    process.stdout.write(turn.text);
    if (turn.toolCalls.length > 0) {
      const tools = turn.toolCalls.map((t) => t.toolName).join(", ");
      process.stdout.write(`\n\n— ${turn.toolCalls.length} tool call(s) (${tools})\n`);
    }
    if (turn.usage) {
      process.stdout.write(`— usage: ${JSON.stringify(turn.usage)}\n`);
    }
    if (turn.sessionId) {
      process.stdout.write(`— session: ${turn.sessionId}\n`);
    }
    return process.exit(0);
  } catch (err) {
    /** @type {string} */
    let message;
    if (err instanceof Error) {
      message = err.message;
    } else if (typeof err === "object" && err !== null && "exitCode" in err) {
      const e = /** @type {any} */ (err);
      message = `${backend} exited ${e.exitCode}: ${e.stderr}`;
    } else {
      message = String(err);
    }
    process.stderr.write(`${scriptName} error: ${message}\n`);
    return process.exit(1);
  }
}
