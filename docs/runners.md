# Stateless runners

Each backend's CLI exposes a stateless one-shot mode in addition to the
ACP long-running mode. The runners under `lib/runners/` are thin spawn
wrappers that drive a single CLI turn end-to-end and return a
`TurnResult` — the call shape is `(options) => Promise<TurnResult>`.

| Runner           | CLI mode                                     | Translator                   | Module                         |
| ---------------- | -------------------------------------------- | ---------------------------- | ------------------------------ |
| `runClaudePrint` | `claude --print --output-format=stream-json` | `translateClaudeStreamEvent` | `lib/runners/claude-print.mjs` |
| `runCodexExec`   | `codex exec --json`                          | `translateCodexStreamEvent`  | `lib/runners/codex-exec.mjs`   |
| `runGeminiPrint` | `gemini -p <prompt> -o stream-json`          | `translateGeminiStreamEvent` | `lib/runners/gemini-print.mjs` |

All three runners are dispatched via `runStatelessTurn(BACKEND_NAMES.<X>, options)` from `lib/runners/dispatch.mjs`. Note that `gemini --acp` (long-running, broker-shared) is still the **primary** runtime path for Gemini via `runAcpPrompt`; `runGeminiPrint` is the one-shot stateless alternative.

## Why stateless runners exist

The primary path for the runtime is **ACP mode** — long-running
`gemini --acp` / `codex acp` subprocesses driven by `runAcpPrompt`. The
stateless runners exist for:

1. **Claude support** — the Claude CLI doesn't ship ACP mode yet, so
   `runClaudePrint` is the only way to drive Claude through this
   runtime today.
2. **One-shot bypass** — for slash commands that genuinely run once and
   don't need session reuse, a stateless invocation is cheaper than
   spinning up the broker. Each run is independent; no broker socket;
   no shared subprocess.
3. **Hermetic test isolation** — stateless runs avoid the broker's
   shared state, simplifying test setup.

## Anatomy

```
runner (spawn lifecycle, AbortSignal, exit-code handling)
   │
   ├─ buildArgs (pure)                             — argv from typed config
   │
   ▼
spawn(command, args)
   │
   ├─ child.stdout
   │     │
   │     ▼
   │   consumeStreamJson (pure stream consumer)    — line-by-line
   │     │
   │     ▼
   │   translate*StreamEvent (pure event mapper)   — to ACP session/update
   │     │
   │     ▼
   │   TurnResult { text, toolCalls, toolResults, usage, reason, ... }
   │
   ├─ child.stderr → buffered for error reporting
   │
   └─ child.exit  → resolve / reject the runner's promise
```

The pure layers (`buildArgs`, `translate*StreamEvent`,
`consumeStreamJson`) are independently tested. The runner is a thin
wrapper that ties them to a real subprocess.

## `runClaudePrint`

```js
import { runClaudePrint } from "#lib/runners/claude-print.mjs";

const turn = await runClaudePrint({
  prompt: "Review the staged diff and flag any security issues.",
  cwd: process.cwd(),
  model: "sonnet",
  effort: "high",
  permissionMode: "acceptEdits",
  // Forced internally: print: true, outputFormat: "stream-json"
});

console.log(turn.text); // "Found two issues: ..."
console.log(turn.toolCalls); // [{ toolName: "Read", toolUseId: "...", args: {...} }, ...]
console.log(turn.usage); // { input_tokens: 1234, output_tokens: 567, ... }
console.log(turn.reason); // "success" / "error_max_turns" / etc.
```

### Options

All `ClaudeBackendConfig` fields plus:

| Option          | Type          | Notes                                                            |
| --------------- | ------------- | ---------------------------------------------------------------- |
| `prompt`        | `string`      | Required. Positional arg appended to argv last.                  |
| `signal`        | `AbortSignal` | Optional. SIGTERM the child + reject with the abort reason.      |
| `timeoutMs`     | `number`      | Optional. SIGTERM + reject after N ms if not yet resolved.       |
| `_argsOverride` | `string[]`    | Test seam — bypasses `buildClaudeArgs`. Production callers omit. |

### Lifecycle

| Event                                 | Resolution                                                  |
| ------------------------------------- | ----------------------------------------------------------- |
| Child writes events + exits 0         | resolves with the accumulated `TurnResult`                  |
| Child exits 0 with no events          | rejects: `"runClaudePrint: child exited before any output"` |
| Child exits non-zero                  | rejects with `{ exitCode: number, stderr: string }`         |
| Spawn fails (`ENOENT`, `EACCES`, ...) | rejects with the spawn error (preserves `code`)             |
| AbortSignal fires                     | SIGTERM child, rejects with `signal.reason`                 |
| `timeoutMs` fires                     | SIGTERM child, rejects with `Error("timed out after Nms")`  |

### Required-with-print invariants

`buildClaudeArgs` enforces that print-only flags (`outputFormat`,
`inputFormat`, `fallbackModel`, `maxBudgetUsd`,
`includePartialMessages`, `includeHookEvents`,
`noSessionPersistence`) are only emitted when `print: true`. The runner
forces `print: true` internally, so all those flags are valid in the
runner's config.

## `runCodexExec`

```js
import { runCodexExec } from "#lib/runners/codex-exec.mjs";

const turn = await runCodexExec({
  prompt: "Refactor the cache layer.",
  cwd: process.cwd(),
  model: "gpt-5-codex",
  effort: "high",
  configOverrides: { sandbox: "workspace-write" },
  quiet: true,
});

console.log(turn.text);
console.log(turn.toolCalls);
console.log(turn.usage);
```

### Options

| Option            | Type                                   | Notes                                           |
| ----------------- | -------------------------------------- | ----------------------------------------------- |
| `prompt`          | `string`                               | Required. Positional arg appended to argv last. |
| `cwd` / `env`     | `string` / `ProcessEnv`                | Standard subprocess wiring.                     |
| `command`         | `string`                               | Override binary (default `codex`). Test seam.   |
| `model`           | `string`                               | `--model <id>`.                                 |
| `effort`          | `"low" \| "medium" \| "high" \| "max"` | `--effort <level>`.                             |
| `profile`         | `string`                               | `--profile <name>` — codex config profile.      |
| `configOverrides` | `Record<string, string>`               | Each pair becomes `-c key=value`.               |
| `quiet`           | `boolean`                              | `--quiet` — suppress banner output.             |
| `extraArgs`       | `string[]`                             | Pass-through, appended before prompt.           |
| `signal`          | `AbortSignal`                          | SIGTERM-on-abort.                               |
| `_argsOverride`   | `string[]`                             | Test seam.                                      |

### `buildCodexExecArgs`

Pure argv builder, exported separately for testing and for callers that
need to inspect the argv before spawn:

```js
import { buildCodexExecArgs } from "#lib/runners/codex-exec.mjs";

buildCodexExecArgs({
  prompt: "the prompt",
  model: "spark",
  effort: "high",
});
// → ["exec", "--json", "--model", "spark", "--effort", "high", "the prompt"]
```

Prompt is **always last** so flag-edge-case prompts (e.g. ones that start
with `-`) don't get re-interpreted as flags by codex's parser.

## `runGeminiPrint`

```js
import { runGeminiPrint } from "#lib/runners/gemini-print.mjs";

const turn = await runGeminiPrint({
  prompt: "Summarize what changed in HEAD~1..HEAD.",
  cwd: process.cwd(),
  model: "gemini-3-flash-preview",
  approvalMode: "plan", // read-only — safe default for one-shot
});

console.log(turn.text);
console.log(turn.usage); // { promptTokenCount, candidatesTokenCount, totalTokenCount }
```

### Options

| Option               | Type                                           | Notes                                                        |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| `prompt`             | `string`                                       | Required. Lands as `-p <prompt>` (always last argv).         |
| `cwd` / `env`        | `string` / `ProcessEnv`                        | Standard subprocess wiring.                                  |
| `command`            | `string`                                       | Override binary (default `gemini`). Test seam.               |
| `model`              | `string`                                       | `-m <id>`.                                                   |
| `approvalMode`       | `"default" \| "auto_edit" \| "yolo" \| "plan"` | `--approval-mode <mode>`. Wins over `yolo` when both set.    |
| `yolo`               | `boolean`                                      | `--yolo`. Mutually exclusive with `approvalMode`.            |
| `includeDirectories` | `string[]`                                     | `--include-directories <comma-joined>`. Empty array dropped. |
| `extraArgs`          | `string[]`                                     | Pass-through; appended before `-p` so prompt stays last.     |
| `signal`             | `AbortSignal`                                  | SIGTERM-on-abort.                                            |
| `timeoutMs`          | `number`                                       | SIGTERM + reject after N ms if not yet resolved.             |
| `_argsOverride`      | `string[]`                                     | Test seam.                                                   |

### `buildGeminiPrintArgs`

Pure argv builder, exported separately:

```js
import { buildGeminiPrintArgs } from "#lib/runners/gemini-print.mjs";

buildGeminiPrintArgs({
  prompt: "the prompt",
  model: "gemini-3-pro-preview",
  approvalMode: "plan",
});
// → ["-o", "stream-json", "--approval-mode", "plan", "-m", "gemini-3-pro-preview", "-p", "the prompt"]
```

### Translator note

`translateGeminiStreamEvent` is the lightest-weight of the three
translators because gemini's `-o stream-json` event names already match
ACP `session/update` kinds (`agent_message_chunk`,
`agent_thought_chunk`, `tool_call`, `tool_result`, `turn_completed`).
The translator's job is mostly:

1. Unwrap JSON-RPC `session/update` envelopes when present.
2. Pass through bare `{sessionUpdate, content, ...}` shapes.
3. Drop non-ACP kinds like `file_change` (no target in `TurnResult`).

## TurnResult shape

All three runners return the same `TurnResult` (defined in
`lib/translate/stream-runner.mjs`):

```ts
{
  text: string;                  // accumulated agent_message_chunk content
  thoughtText: string;           // accumulated agent_thought_chunk content
  chunkCount: number;
  chunkChars: number;
  thoughtCount: number;
  thoughtChars: number;
  toolCalls: Array<{ toolName, toolUseId, args }>;
  toolResults: Array<{ toolUseId, result, isError }>;
  usage: any | null;             // backend-shaped (Claude has cache_creation_input_tokens, codex doesn't)
  reason: string | null;         // "success" / "end_turn" / "error_max_turns" / etc.
  updates: SessionUpdate[];      // every translated update in order (raw stream)
}
```

`updates[]` is the unfiltered translation log — useful for callers that
want to apply their own accumulator or inspect the streaming order.

## Testing pattern

Both runners' integration tests follow the same hermetic pattern: a
`node -e <script>` fake that emits synthetic stream-json events on
stdout. The `_argsOverride` test seam bypasses the canonical CLI args
because node's argv parser would otherwise choke on flags like
`--output-format`.

Real-binary smoke tests belong in a separate manual script — neither
runner is exercised against the actual `claude` or `codex` binaries in
CI to keep tests hermetic.

## When to use

| Scenario                                           | Use                                                   |
| -------------------------------------------------- | ----------------------------------------------------- |
| Multi-turn agent session, broker-shared subprocess | `runAcpPrompt` (ACP mode — gemini-only today)         |
| One-shot review on the working tree                | `runAcpReview` if broker is up, else stateless runner |
| Claude-driven invocation                           | `runClaudePrint` (no ACP option exists)               |
| Codex bypass without ACP overhead                  | `runCodexExec`                                        |
| Gemini one-shot without spinning the broker        | `runGeminiPrint`                                      |
| Backend-agnostic dispatch                          | `runStatelessTurn(BACKEND_NAMES.<X>, options)`        |
| Testing translator + stream-runner end-to-end      | Direct `consumeStreamJson` with synthetic streams     |

## See also

- `docs/cli-options-research.md` — per-CLI flag inventory.
- `docs/backends/{gemini,codex,claude}.md` — per-backend ACP-mode docs.
- `docs/plugins.md` — multi-plugin cross-pollination model that consumes these runners.
- `lib/runners/dispatch.mjs` — `runStatelessTurn` dispatcher that fans out to the three runners.
- `lib/translate/stream-runner.mjs` — pure stream consumer (composable
  beyond just these runners).
- `lib/translate/{gemini,codex,claude}-stream.mjs` — pure event translators.
