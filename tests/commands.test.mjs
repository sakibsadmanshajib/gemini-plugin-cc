import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "gemini");
const COMPANION_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "gemini-companion.mjs");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command is a deterministic direct-execution entrypoint", () => {
  const source = read("commands/review.md");
  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /gemini-companion\.mjs" review "\$ARGUMENTS"/);
  assert.match(source, /Do not paraphrase, summarize, or add your own commentary/i);
  assert.match(source, /Do not make any code changes/i);
  assert.match(source, /\[--base <ref>\]/);
  assert.match(source, /\[--scope <auto\|working-tree\|branch>\]/);
});

test("adversarial review command is a deterministic direct-execution entrypoint", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /gemini-companion\.mjs" adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /Do not paraphrase, summarize, or add your own commentary/i);
  assert.match(source, /Do not make any code changes/i);
  assert.match(source, /Do not fix any issues/i);
  assert.match(source, /\[--base <ref>\]/);
  assert.match(source, /\[--scope <auto\|working-tree\|branch>\]/);
});

test("command files match expected set", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("rescue command uses inline execution without subagent delegation", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/gemini-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/gemini-cli-runtime/SKILL.md");

  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion/);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <name>/);
  assert.match(rescue, /--thinking-budget <number>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /AskUserQuestion/);
  assert.match(rescue, /Continue current Gemini thread/);
  assert.match(rescue, /Start a new Gemini thread/);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /`--model` and `--thinking-budget` are runtime-selection flags/i);
  assert.match(rescue, /Leave `--thinking-budget` unset unless the user explicitly asks/i);
  assert.match(rescue, /If they ask for `flash`, map it to `--model gemini-2\.5-flash`/i);
  assert.match(rescue, /If they ask for `flash-lite`, map it to `--model gemini-2\.5-flash-lite`/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /thin forwarding wrapper/i);
  assert.match(rescue, /Return the Gemini companion stdout verbatim to the user/i);
  assert.match(rescue, /Do not paraphrase, summarize, rewrite, or add commentary before or after it/i);
  assert.match(rescue, /return that command's stdout as-is/i);
  assert.match(rescue, /Do not spawn subagents, do not invoke skills/i);
  assert.match(rescue, /Default to a write-capable Gemini run by adding `--write`/i);
  assert.match(agent, /--resume/);
  assert.match(agent, /--fresh/);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave `--thinking-budget` unset unless the user explicitly requests a specific thinking budget/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /If the user asks for `flash`, map that to `--model gemini-2\.5-flash`/i);
  assert.match(agent, /Return the stdout of the `gemini-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Gemini cannot be invoked, return nothing/i);
  assert.match(agent, /gemini-prompting/);
  assert.match(agent, /only to tighten the user's request into a better Gemini prompt/i);
  assert.match(agent, /Do not use that skill to inspect the repository, reason through the problem yourself, draft a solution, or do any independent work/i);
  assert.match(runtimeSkill, /gemini-companion\.mjs" task/);
  assert.match(runtimeSkill, /--resume-last/);
  assert.match(readme, /`gemini:gemini-rescue` subagent/i);
  assert.match(readme, /if you do not pass `--model`, Gemini chooses its own defaults/i);
  assert.match(readme, /### `\/gemini:setup`/);
  assert.match(readme, /### `\/gemini:review`/);
  assert.match(readme, /### `\/gemini:adversarial-review`/);
  assert.match(readme, /uses the same review target selection as `\/gemini:review`/i);
  assert.match(readme, /--base main challenge whether this was the right caching and retry design/);
  assert.match(readme, /### `\/gemini:rescue`/);
  assert.match(readme, /### `\/gemini:status`/);
  assert.match(readme, /### `\/gemini:result`/);
  assert.match(readme, /### `\/gemini:cancel`/);
});

test("result and cancel commands are exposed as deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const resultHandling = read("skills/gemini-result-handling/SKILL.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /gemini-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /gemini-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Gemini run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Gemini was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology for rescue runs", () => {
  const runtimeSkill = read("skills/gemini-cli-runtime/SKILL.md");
  const promptingSkill = read("skills/gemini-prompting/SKILL.md");
  const promptRecipes = read("skills/gemini-prompting/references/gemini-prompt-recipes.md");

  assert.match(runtimeSkill, /gemini-companion\.mjs" task/);
  assert.match(runtimeSkill, /--resume-last/);
  assert.match(promptingSkill, /Gemini/);
  assert.match(promptRecipes, /Gemini task prompts/i);
});

test("hooks keep session-end cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command can offer Gemini install and still points users to gemini auth", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\]'/);
  assert.match(setup, /AskUserQuestion/);
  assert.match(setup, /npm install -g @google\/gemini-cli/);
  assert.match(setup, /gemini-companion\.mjs" setup --json "\$ARGUMENTS"/);
  assert.match(readme, /!gemini/);
  assert.match(readme, /offer to install.*for you/i);
  assert.match(readme, /\/gemini:setup --enable-review-gate/);
  assert.match(readme, /\/gemini:setup --disable-review-gate/);
});

test("companion command handlers use raw command argument parsing", () => {
  const source = fs.readFileSync(COMPANION_SCRIPT, "utf8");

  assert.match(source, /import \{ parseCommandInput \} from "\.\/lib\/args\.mjs"/);
  assert.doesNotMatch(source, /\bparseArgs\(/);
});
