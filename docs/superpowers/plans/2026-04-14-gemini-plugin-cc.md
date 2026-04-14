# gemini-plugin-cc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Claude Code plugin that delegates tasks to Google's Gemini CLI via ACP, with full parity to openai/codex-plugin-cc.

**Architecture:** Three-layer plugin (markdown declarations, Node.js companion scripts, ACP JSON-RPC integration) with a broker pattern for persistent Gemini process reuse. Commands mirror Codex plugin: review, adversarial-review, rescue, setup, status, result, cancel.

**Tech Stack:** Node.js 18.18+ (ESM .mjs), Claude Code plugin system (markdown frontmatter), Gemini CLI ACP mode (JSON-RPC 2.0 over stdio), Unix sockets / named pipes for broker.

---

## File Map

### Plugin Manifests
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/gemini/.claude-plugin/plugin.json`
- Create: `plugins/gemini/hooks/hooks.json`
- Create: `package.json`
- Create: `plugins/gemini/LICENSE`

### Commands (7)
- Create: `plugins/gemini/commands/review.md`
- Create: `plugins/gemini/commands/adversarial-review.md`
- Create: `plugins/gemini/commands/rescue.md`
- Create: `plugins/gemini/commands/setup.md`
- Create: `plugins/gemini/commands/status.md`
- Create: `plugins/gemini/commands/result.md`
- Create: `plugins/gemini/commands/cancel.md`

### Agent
- Create: `plugins/gemini/agents/gemini-rescue.md`

### Skills (3 + references)
- Create: `plugins/gemini/skills/gemini-cli-runtime/SKILL.md`
- Create: `plugins/gemini/skills/gemini-result-handling/SKILL.md`
- Create: `plugins/gemini/skills/gemini-prompting/SKILL.md`
- Create: `plugins/gemini/skills/gemini-prompting/references/prompt-blocks.md`
- Create: `plugins/gemini/skills/gemini-prompting/references/gemini-prompt-recipes.md`
- Create: `plugins/gemini/skills/gemini-prompting/references/gemini-prompt-antipatterns.md`

### Prompts
- Create: `plugins/gemini/prompts/adversarial-review.md`
- Create: `plugins/gemini/prompts/stop-review-gate.md`

### Schema
- Create: `plugins/gemini/schemas/review-output.schema.json`

### Scripts - Lib (15 modules)
- Create: `plugins/gemini/scripts/lib/acp-client.mjs` (ACP JSON-RPC client, direct + broker modes)
- Create: `plugins/gemini/scripts/lib/acp-protocol.d.ts` (TypeScript type definitions for ACP)
- Create: `plugins/gemini/scripts/lib/gemini.mjs` (core Gemini functions: reviews, tasks, auth)
- Create: `plugins/gemini/scripts/lib/state.mjs` (job state persistence)
- Create: `plugins/gemini/scripts/lib/git.mjs` (git operations for review context)
- Create: `plugins/gemini/scripts/lib/render.mjs` (markdown output rendering)
- Create: `plugins/gemini/scripts/lib/tracked-jobs.mjs` (job lifecycle tracking)
- Create: `plugins/gemini/scripts/lib/job-control.mjs` (job querying, enrichment)
- Create: `plugins/gemini/scripts/lib/broker-lifecycle.mjs` (broker process management)
- Create: `plugins/gemini/scripts/lib/broker-endpoint.mjs` (Unix socket/named pipe endpoint)
- Create: `plugins/gemini/scripts/lib/process.mjs` (process spawning/termination)
- Create: `plugins/gemini/scripts/lib/prompts.mjs` (template loading/interpolation)
- Create: `plugins/gemini/scripts/lib/args.mjs` (argument parsing)
- Create: `plugins/gemini/scripts/lib/fs.mjs` (file system utilities)
- Create: `plugins/gemini/scripts/lib/workspace.mjs` (workspace root resolution)

### Scripts - Top-level (4)
- Create: `plugins/gemini/scripts/gemini-companion.mjs` (main CLI entry point)
- Create: `plugins/gemini/scripts/acp-broker.mjs` (persistent ACP broker daemon)
- Create: `plugins/gemini/scripts/session-lifecycle-hook.mjs` (SessionStart/End hook)
- Create: `plugins/gemini/scripts/stop-review-gate-hook.mjs` (Stop review gate hook)

---

## Task 1: Plugin Manifests and Configuration

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugins/gemini/.claude-plugin/plugin.json`
- Create: `plugins/gemini/hooks/hooks.json`
- Create: `package.json`
- Create: `plugins/gemini/LICENSE`

- [ ] **Step 1: Create marketplace.json**

```json
{
  "name": "google-gemini",
  "owner": {
    "name": "Google"
  },
  "metadata": {
    "description": "Gemini plugins to use in Claude Code for delegation and code review.",
    "version": "1.0.0"
  },
  "plugins": [
    {
      "name": "gemini",
      "description": "Use Gemini from Claude Code to review code or delegate tasks.",
      "version": "1.0.0",
      "author": {
        "name": "Google"
      },
      "source": "./plugins/gemini"
    }
  ]
}
```

- [ ] **Step 2: Create plugin.json**

```json
{
  "name": "gemini",
  "version": "1.0.0",
  "description": "Use Gemini from Claude Code to review code or delegate tasks.",
  "author": {
    "name": "Google"
  }
}
```

- [ ] **Step 3: Create hooks.json**

```json
{
  "description": "Optional stop-time review gate for Gemini Companion.",
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionStart",
            "timeout": 5
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/session-lifecycle-hook.mjs\" SessionEnd",
            "timeout": 5
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/stop-review-gate-hook.mjs\"",
            "timeout": 900
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 4: Create package.json**

```json
{
  "name": "gemini-plugin-cc",
  "version": "1.0.0",
  "description": "Claude Code plugin for Gemini CLI delegation and code review.",
  "type": "module",
  "engines": {
    "node": ">=18.18.0"
  },
  "license": "Apache-2.0"
}
```

- [ ] **Step 5: Create LICENSE (Apache 2.0)**

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: add plugin manifests and configuration"
```

---

## Task 2: Lib - Foundation Modules

**Files:**
- Create: `plugins/gemini/scripts/lib/args.mjs`
- Create: `plugins/gemini/scripts/lib/fs.mjs`
- Create: `plugins/gemini/scripts/lib/process.mjs`
- Create: `plugins/gemini/scripts/lib/workspace.mjs`
- Create: `plugins/gemini/scripts/lib/prompts.mjs`

These are zero-dependency utility modules used by everything else.

- [ ] **Step 1: Create args.mjs** - Argument parser matching Codex's `parseArgs` and `splitRawArgumentString`
- [ ] **Step 2: Create fs.mjs** - File utilities: `readJsonFile`, `isProbablyText`, `readFileSafe`
- [ ] **Step 3: Create process.mjs** - Process spawning: `runCommand`, `runCommandChecked`, `formatCommandFailure`, `terminateProcessTree`, `binaryAvailable`
- [ ] **Step 4: Create workspace.mjs** - `resolveWorkspaceRoot` using git rev-parse
- [ ] **Step 5: Create prompts.mjs** - Template loading and `{{VARIABLE}}` interpolation
- [ ] **Step 6: Commit**

---

## Task 3: Lib - State and Job Management

**Files:**
- Create: `plugins/gemini/scripts/lib/state.mjs`
- Create: `plugins/gemini/scripts/lib/tracked-jobs.mjs`
- Create: `plugins/gemini/scripts/lib/job-control.mjs`

- [ ] **Step 1: Create state.mjs** - Job state persistence with `resolveStateDir`, `loadState`, `saveState`, `upsertJob`, `readJobFile`, `writeJobFile`, `listJobs`, `getConfig`, `setConfig`
- [ ] **Step 2: Create tracked-jobs.mjs** - Job lifecycle: `createTrackedJob`, `runTrackedJob`, `SESSION_ID_ENV`
- [ ] **Step 3: Create job-control.mjs** - Job querying: `sortJobsNewestFirst`, `filterJobsForCurrentSession`, `enrichJob`, `buildStatusSnapshot`, `buildSingleJobSnapshot`, `resolveResultJob`, `resolveCancelableJob`
- [ ] **Step 4: Commit**

---

## Task 4: Lib - Git Operations

**Files:**
- Create: `plugins/gemini/scripts/lib/git.mjs`

- [ ] **Step 1: Create git.mjs** - Git context collection: `ensureGitRepository`, `collectWorkingTreeContext`, `collectBranchContext`, `buildWorkingTreeSummary`, `buildBranchComparison`, inline diff helpers, untracked file collection
- [ ] **Step 2: Commit**

---

## Task 5: Lib - ACP Client and Broker

**Files:**
- Create: `plugins/gemini/scripts/lib/acp-protocol.d.ts`
- Create: `plugins/gemini/scripts/lib/acp-client.mjs`
- Create: `plugins/gemini/scripts/lib/broker-endpoint.mjs`
- Create: `plugins/gemini/scripts/lib/broker-lifecycle.mjs`

This is the most critical adaptation. Codex uses `codex app-server` (JSON-RPC over stdio). We use `gemini --acp` (also JSON-RPC over stdio, but different protocol methods).

- [ ] **Step 1: Create acp-protocol.d.ts** - TypeScript type definitions for Gemini ACP methods: `initialize`, `authenticate`, `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`, `unstable_setSessionModel`

- [ ] **Step 2: Create broker-endpoint.mjs** - `createBrokerEndpoint` (Unix socket on Linux/macOS, named pipe on Windows), `parseBrokerEndpoint`. Same as Codex but with `gemini-acp` prefix instead of `codex-app-server`.

- [ ] **Step 3: Create acp-client.mjs** - Three classes mirroring Codex's app-server.mjs:
  - `AcpClientBase` - Shared JSON-RPC logic (request/response matching, notification dispatching, line-delimited parsing)
  - `SpawnedAcpClient` - Spawns `gemini --acp` as child process, communicates via stdin/stdout
  - `BrokerAcpClient` - Connects to broker via Unix socket
  - `GeminiAcpClient` - Factory: tries broker first, falls back to direct spawn
  - Exports: `BROKER_BUSY_RPC_CODE`, `BROKER_ENDPOINT_ENV`, `GeminiAcpClient`

- [ ] **Step 4: Create broker-lifecycle.mjs** - Broker management: `ensureBrokerSession`, `loadBrokerSession`, `saveBrokerSession`, `clearBrokerSession`, `teardownBrokerSession`, `sendBrokerShutdown`, `waitForBrokerEndpoint`

- [ ] **Step 5: Commit**

---

## Task 6: Lib - Core Gemini Functions

**Files:**
- Create: `plugins/gemini/scripts/lib/gemini.mjs`

- [ ] **Step 1: Create gemini.mjs** - Core functions adapting Codex's codex.mjs for Gemini ACP:
  - `getGeminiAvailability()` - Check if `gemini` binary exists
  - `getGeminiAuthStatus(cwd)` - Use ACP `authenticate` or check env vars
  - `getSessionRuntimeStatus(env, cwd)` - Check broker status
  - `runAcpPrompt(cwd, prompt, options)` - Send prompt via ACP `prompt` method, capture response
  - `runAcpReview(cwd, options)` - Build review prompt from git context, send via ACP
  - `runAcpAdversarialReview(cwd, options)` - Build adversarial prompt with template, send via ACP
  - `interruptAcpPrompt(cwd, options)` - Cancel via ACP `cancel` method
  - `findLatestTaskThread(cwd)` - Find resumable session
  - `parseStructuredOutput(text)` - Parse JSON from model response
  - `readOutputSchema(schemaPath)` - Read review output schema
  - `captureTurn(client, startFn, options)` - Capture ACP response with progress reporting

- [ ] **Step 2: Commit**

---

## Task 7: Lib - Rendering

**Files:**
- Create: `plugins/gemini/scripts/lib/render.mjs`

- [ ] **Step 1: Create render.mjs** - Output rendering:
  - `renderReviewResult(review)` - Format review findings as markdown
  - `renderStatusSnapshot(snapshot)` - Format status table
  - `renderSingleJobStatus(job)` - Detailed single job view
  - `renderResultOutput(cwd, job)` - Render stored job result
  - `renderCancelReport(job)` - Cancel confirmation
  - `renderSetupReport(report)` - Setup status display
  - `outputCommandResult(payload, rendered, json)` - JSON or rendered output switch

- [ ] **Step 2: Commit**

---

## Task 8: Top-Level Scripts - Broker and Hooks

**Files:**
- Create: `plugins/gemini/scripts/acp-broker.mjs`
- Create: `plugins/gemini/scripts/session-lifecycle-hook.mjs`
- Create: `plugins/gemini/scripts/stop-review-gate-hook.mjs`

- [ ] **Step 1: Create acp-broker.mjs** - Persistent broker daemon:
  - Listens on Unix socket (from `--endpoint` arg)
  - Spawns single `gemini --acp` child process
  - Multiplexes JSON-RPC requests from client connections
  - Returns `-32001` (busy) when another request is in flight
  - Handles `broker/shutdown` method for clean exit
  - Writes PID file for lifecycle management

- [ ] **Step 2: Create session-lifecycle-hook.mjs** - Session hooks:
  - `SessionStart`: Read hook input from stdin, export `GEMINI_COMPANION_SESSION_ID` and `CLAUDE_PLUGIN_DATA` to `CLAUDE_ENV_FILE`
  - `SessionEnd`: Shut down broker, clean up session jobs (kill running processes, remove state)

- [ ] **Step 3: Create stop-review-gate-hook.mjs** - Stop gate:
  - Read hook input (includes Claude's last response)
  - Check if review gate is enabled in config
  - Check if Gemini is available and authenticated
  - Load stop-review-gate prompt template
  - Send to Gemini via ACP
  - Parse ALLOW/BLOCK from first line
  - Emit `{decision, reason}` JSON to stdout

- [ ] **Step 4: Commit**

---

## Task 9: Main Entry Point - gemini-companion.mjs

**Files:**
- Create: `plugins/gemini/scripts/gemini-companion.mjs`

- [ ] **Step 1: Create gemini-companion.mjs** - Main CLI with subcommands:
  - `setup` - Check Gemini availability, auth, toggle review gate
  - `review` - Run review via ACP with git context
  - `adversarial-review` - Run adversarial review with template
  - `task` - Run arbitrary task via ACP (foreground)
  - `task-worker` - Background job worker
  - `status` - List jobs
  - `result` - Show job result
  - `cancel` - Cancel job
  - `task-resume-candidate` - Find resumable task
  - Flags: `--model`, `--thinking-budget`, `--approval-mode`, `--write`, `--background`, `--wait`, `--resume-last`, `--fresh`, `--base`, `--scope`, `--json`, `--cwd`

- [ ] **Step 2: Commit**

---

## Task 10: Commands

**Files:**
- Create: `plugins/gemini/commands/review.md`
- Create: `plugins/gemini/commands/adversarial-review.md`
- Create: `plugins/gemini/commands/rescue.md`
- Create: `plugins/gemini/commands/setup.md`
- Create: `plugins/gemini/commands/status.md`
- Create: `plugins/gemini/commands/result.md`
- Create: `plugins/gemini/commands/cancel.md`

Each command is a markdown file with YAML frontmatter. The frontmatter specifies: name, description, argument-hint, disable-model-invocation, allowed-tools, context.

- [ ] **Step 1: Create all 7 command files** (see spec for behavior per command)
- [ ] **Step 2: Commit**

---

## Task 11: Agent, Skills, Prompts, Schema

**Files:**
- Create: `plugins/gemini/agents/gemini-rescue.md`
- Create: `plugins/gemini/skills/gemini-cli-runtime/SKILL.md`
- Create: `plugins/gemini/skills/gemini-result-handling/SKILL.md`
- Create: `plugins/gemini/skills/gemini-prompting/SKILL.md`
- Create: `plugins/gemini/skills/gemini-prompting/references/prompt-blocks.md`
- Create: `plugins/gemini/skills/gemini-prompting/references/gemini-prompt-recipes.md`
- Create: `plugins/gemini/skills/gemini-prompting/references/gemini-prompt-antipatterns.md`
- Create: `plugins/gemini/prompts/adversarial-review.md`
- Create: `plugins/gemini/prompts/stop-review-gate.md`
- Create: `plugins/gemini/schemas/review-output.schema.json`

- [ ] **Step 1: Create gemini-rescue agent** - Thin forwarding wrapper, model: sonnet, tools: Bash, skills: gemini-cli-runtime + gemini-prompting
- [ ] **Step 2: Create gemini-cli-runtime skill** - Contract for calling `gemini-companion.mjs task` with all flags
- [ ] **Step 3: Create gemini-result-handling skill** - Output presentation rules
- [ ] **Step 4: Create gemini-prompting skill + references** - Gemini-specific prompting guide with system instructions, prompt blocks, recipes, anti-patterns
- [ ] **Step 5: Create adversarial-review prompt template**
- [ ] **Step 6: Create stop-review-gate prompt template**
- [ ] **Step 7: Create review-output schema** (identical to Codex)
- [ ] **Step 8: Commit**

---

## Task 12: Final Review

- [ ] **Step 1: Verify file structure matches spec**
- [ ] **Step 2: Check all cross-file references (imports, paths)**
- [ ] **Step 3: Verify naming consistency (GEMINI_COMPANION_* env vars, gemini-* prefixes)**
- [ ] **Step 4: Run Node.js syntax check on all .mjs files**
- [ ] **Step 5: Create initial git commit for the complete plugin**
