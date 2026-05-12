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
 * The helper is the **boundary** for the new AgentContext flow: it
 * reads CLI argv + env exactly once, builds a frozen context, and
 * passes that context to `runStatelessTurn`. Lib code downstream
 * reads from context, not from env.
 */

import process from "node:process";

import { buildAgentContextFromArgv, withOverrides } from "#lib/agent-context.mjs";
import { formatHelp } from "#lib/cli/flags.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";
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
  const manifest = readManifest(parsedContext.env);
  /** @type {{ dispatch?: any, facade?: any }} */
  const overrides = {};
  if (manifest && parsedContext.dispatch.facade === "default") {
    overrides.dispatch = { ...parsedContext.dispatch, facade: "on" };
    // If the manifest carries an auto-key retrieve hint AND the user
    // didn't supply --facade-key, attempt to read the key file at the
    // documented location (~/.local/state/artagon-agent-cli-plugin/
    // api-key). When the manifest's autoKey.store is "keychain", the
    // user must run the retrieveCommand themselves; we cannot shell
    // out from here without breaking the auth-secrecy contract.
    // (Auto-key resolution from the manifest is a follow-up.)
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
