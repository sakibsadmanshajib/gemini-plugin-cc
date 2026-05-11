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

import { buildAgentContextFromArgv } from "#lib/agent-context.mjs";
import { formatHelp } from "#lib/cli/flags.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";

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

  const { context, prompt } = parseResult;

  if (!prompt) {
    process.stderr.write(
      `${scriptName}: usage: ${scriptName} [flags] [--] <prompt>\n` +
        `Try \`${scriptName} --help\` for the full flag list.\n`
    );
    return process.exit(2);
  }

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
