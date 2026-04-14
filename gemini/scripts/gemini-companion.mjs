#!/usr/bin/env node

/**
 * Gemini Companion — main CLI entry point for the gemini-plugin-cc Claude Code plugin.
 *
 * Subcommands:
 *   setup                Check Gemini CLI availability, auth, toggle review gate
 *   review               Run a code review via Gemini
 *   adversarial-review   Run a steerable adversarial review
 *   task                 Run an arbitrary task via Gemini (foreground)
 *   task-worker          Background job worker (internal)
 *   status               List jobs
 *   result               Show job result
 *   cancel               Cancel a job
 *   task-resume-candidate  Find a resumable task (internal)
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  getGeminiAuthStatus,
  getGeminiAvailability,
  getSessionRuntimeStatus,
  interruptAcpPrompt,
  parseStructuredOutput,
  readOutputSchema,
  runAcpAdversarialReview,
  runAcpPrompt,
  runAcpReview
} from "./lib/gemini.mjs";
import { getConfig, loadState, readJobFile, setConfig } from "./lib/state.mjs";
import {
  createTrackedJob,
  runTrackedJob,
  SESSION_ID_ENV,
  updateJobPhase
} from "./lib/tracked-jobs.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  resolveCancelableJob,
  resolveResultJob
} from "./lib/job-control.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { binaryAvailable } from "./lib/process.mjs";
import {
  outputCommandResult,
  renderCancelReport,
  renderResultOutput,
  renderReviewResult,
  renderSetupReport,
  renderSingleJobStatus,
  renderStatusSnapshot
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const MODEL_ALIASES = new Map([
  ["flash", "gemini-2.5-flash"],
  ["flash-lite", "gemini-2.5-flash-lite"],
  ["pro", "gemini-2.5-pro"]
]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/gemini-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/gemini-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <name>] [focus text...]",
      "  node scripts/gemini-companion.mjs task [--write] [--model <name>] [--thinking-budget <n>] [--approval-mode <mode>] [--background|--wait] [--resume-last] [--json] -- <prompt>",
      "  node scripts/gemini-companion.mjs task-worker <job-id>",
      "  node scripts/gemini-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
      "  node scripts/gemini-companion.mjs result [job-id] [--json]",
      "  node scripts/gemini-companion.mjs cancel [job-id] [--json]",
      "  node scripts/gemini-companion.mjs task-resume-candidate [--json]"
    ].join("\n")
  );
}

function resolveCommandCwd(options) {
  return options.cwd ? path.resolve(options.cwd) : (process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
}

function resolveModel(value) {
  if (!value) {
    return undefined;
  }
  return MODEL_ALIASES.get(value) ?? value;
}

// ─── Setup ────────────────────────────────────────────────────────────────────

async function handleSetup(argv) {
  const { options } = parseArgs(argv, {
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  const cwd = resolveCommandCwd(options);

  // Toggle review gate if requested.
  if (options["enable-review-gate"]) {
    setConfig(cwd, { stopReviewGate: true });
  } else if (options["disable-review-gate"]) {
    setConfig(cwd, { stopReviewGate: false });
  }

  const { available, version } = getGeminiAvailability();
  const npmAvailable = binaryAvailable("npm");
  const config = getConfig(cwd);

  let authenticated = false;
  let authMethod = null;

  if (available) {
    const auth = await getGeminiAuthStatus(cwd);
    authenticated = auth.authenticated;
    authMethod = auth.method;
  }

  const report = {
    geminiAvailable: available,
    geminiVersion: version,
    authenticated,
    authMethod,
    npmAvailable,
    reviewGate: config.stopReviewGate,
    message: !available
      ? "Gemini CLI is not installed. Install with: npm install -g @google/gemini-cli"
      : !authenticated
        ? "Gemini CLI is installed but not authenticated. Run `!gemini` to authenticate interactively, or set GEMINI_API_KEY."
        : null
  };

  const rendered = renderSetupReport(report);
  outputCommandResult(report, rendered, options.json);
}

// ─── Review ───────────────────────────────────────────────────────────────────

async function handleReview(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "wait", "background"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);

  if (options.background) {
    return runReviewInBackground(workspaceRoot, options, "review");
  }

  const result = await runAcpReview(cwd, {
    scope: options.scope,
    base: options.base,
    model: resolveModel(options.model)
  });

  if (result.error) {
    process.stderr.write(`Review failed: ${result.error?.message ?? result.error}\n`);
    process.exit(1);
  }

  const payload = {
    scope: result.scope,
    summary: result.summary,
    review: result.text,
    sessionId: result.sessionId
  };

  outputCommandResult(payload, result.text, options.json);
}

// ─── Adversarial Review ───────────────────────────────────────────────────────

async function handleReviewCommand(argv, { reviewName }) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "wait", "background"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const focus = positionals.join(" ").trim() || undefined;

  if (options.background) {
    return runReviewInBackground(workspaceRoot, { ...options, focus }, "adversarial-review");
  }

  const result = await runAcpAdversarialReview(cwd, {
    scope: options.scope,
    base: options.base,
    model: resolveModel(options.model),
    focus,
    schemaPath: REVIEW_SCHEMA
  });

  if (result.error) {
    process.stderr.write(`${reviewName} failed: ${result.error?.message ?? result.error}\n`);
    process.exit(1);
  }

  if (result.parsed) {
    const rendered = renderReviewResult(result.parsed);
    outputCommandResult(result.parsed, rendered, options.json);
  } else {
    outputCommandResult({ raw: result.text }, result.text, options.json);
  }
}

// ─── Task ─────────────────────────────────────────────────────────────────────

async function handleTask(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["model", "thinking-budget", "approval-mode", "cwd"],
    booleanOptions: ["json", "write", "background", "wait", "resume-last"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const taskText = positionals.join(" ").trim();

  if (!taskText && !options["resume-last"]) {
    process.stderr.write("Error: No task text provided.\n");
    printUsage();
    process.exit(1);
  }

  const model = resolveModel(options.model);
  const thinkingBudget = options["thinking-budget"] ? Number(options["thinking-budget"]) : undefined;
  const approvalMode = options.write ? "auto_edit" : (options["approval-mode"] ?? "auto_edit");

  // Handle resume.
  let prompt = taskText || DEFAULT_CONTINUE_PROMPT;
  let sessionId = null;
  if (options["resume-last"]) {
    const candidate = await findLatestTaskThread(cwd);
    if (candidate) {
      sessionId = candidate.id;
      process.stderr.write(`Resuming Gemini session: ${sessionId}\n`);
    } else {
      process.stderr.write("No resumable Gemini session found. Starting fresh.\n");
    }
  }

  if (options.background) {
    return runTaskInBackground(workspaceRoot, {
      prompt,
      model,
      thinkingBudget,
      approvalMode,
      sessionId,
      json: options.json
    });
  }

  // Foreground execution.
  const job = createTrackedJob({
    workspaceRoot,
    kind: "task",
    title: buildPersistentTaskThreadName(prompt)
  });

  process.stderr.write(`Gemini task started: ${job.id}\n`);

  try {
    const execution = await runTrackedJob(job, async () => {
      updateJobPhase(workspaceRoot, job.id, "running");

      const result = await runAcpPrompt(cwd, prompt, {
        model,
        approvalMode,
        sessionId
      });

      if (result.error) {
        throw result.error;
      }

      const rendered = result.text;
      const summary = rendered.slice(0, 120).replace(/\n/g, " ").trim();

      return {
        exitStatus: 0,
        threadId: result.sessionId,
        payload: {
          rawOutput: result.text,
          fileChanges: result.fileChanges,
          toolCalls: result.toolCalls
        },
        rendered,
        summary
      };
    });

    outputCommandResult(
      { jobId: job.id, threadId: execution.threadId, text: execution.rendered },
      execution.rendered,
      options.json
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Task failed: ${message}\n`);
    process.exit(1);
  }
}

// ─── Task Worker (Background) ─────────────────────────────────────────────────

async function handleTaskWorker(argv) {
  const jobId = argv[0];
  if (!jobId) {
    process.stderr.write("Error: Missing job ID.\n");
    process.exit(1);
  }

  const cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const storedJob = readJobFile(workspaceRoot, jobId);

  if (!storedJob) {
    process.stderr.write(`Error: Job ${jobId} not found.\n`);
    process.exit(1);
  }

  const request = storedJob.request ?? {};

  try {
    await runTrackedJob(storedJob, async () => {
      updateJobPhase(workspaceRoot, jobId, "running");

      const result = await runAcpPrompt(cwd, request.prompt, {
        model: request.model,
        approvalMode: request.approvalMode ?? "auto_edit",
        sessionId: request.sessionId
      });

      if (result.error) {
        throw result.error;
      }

      const summary = (result.text ?? "").slice(0, 120).replace(/\n/g, " ").trim();

      return {
        exitStatus: 0,
        threadId: result.sessionId,
        payload: {
          rawOutput: result.text,
          fileChanges: result.fileChanges,
          toolCalls: result.toolCalls
        },
        rendered: result.text,
        summary
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Background task failed: ${message}\n`);
    process.exit(1);
  }
}

// ─── Status ───────────────────────────────────────────────────────────────────

async function handleStatus(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["timeout-ms", "cwd"],
    booleanOptions: ["json", "wait", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? null;

  if (reference) {
    const snapshot = buildSingleJobSnapshot(cwd, reference);
    const rendered = renderSingleJobStatus(snapshot);
    outputCommandResult(snapshot, rendered, options.json);
    return;
  }

  if (options.wait) {
    const timeoutMs = Number(options["timeout-ms"]) || DEFAULT_STATUS_WAIT_TIMEOUT_MS;
    await waitForActiveJobs(cwd, timeoutMs, options.json);
    return;
  }

  const snapshot = buildStatusSnapshot(cwd, { env: process.env });
  const rendered = renderStatusSnapshot(snapshot);
  outputCommandResult(snapshot, rendered, options.json);
}

async function waitForActiveJobs(cwd, timeoutMs, json) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const snapshot = buildStatusSnapshot(cwd, { env: process.env });
    if (snapshot.running.length === 0) {
      const rendered = renderStatusSnapshot(snapshot);
      outputCommandResult(snapshot, rendered, json);
      return;
    }

    process.stderr.write(`Waiting for ${snapshot.running.length} active job(s)...\n`);
    await new Promise((r) => setTimeout(r, DEFAULT_STATUS_POLL_INTERVAL_MS));
  }

  const snapshot = buildStatusSnapshot(cwd, { env: process.env });
  const rendered = renderStatusSnapshot(snapshot);
  outputCommandResult(snapshot, rendered, json);
}

// ─── Result ───────────────────────────────────────────────────────────────────

function handleResult(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? null;
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readJobFile(workspaceRoot, job.id);

  const rendered = renderResultOutput(cwd, job, storedJob);
  const payload = {
    jobId: job.id,
    status: job.status,
    threadId: storedJob?.threadId ?? job.threadId ?? null,
    result: storedJob?.result ?? null,
    rendered
  };

  outputCommandResult(payload, rendered, options.json);
}

// ─── Cancel ───────────────────────────────────────────────────────────────────

async function handleCancel(argv) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? null;
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);

  // Try to interrupt the ACP prompt if there's a session.
  const interrupt = await interruptAcpPrompt(cwd, {
    sessionId: job.threadId
  });

  // Update job state.
  const state = loadState(workspaceRoot);
  const jobIndex = state.jobs.findIndex((j) => j.id === job.id);
  if (jobIndex >= 0) {
    state.jobs[jobIndex] = {
      ...state.jobs[jobIndex],
      status: "cancelled",
      phase: "cancelled",
      completedAt: new Date().toISOString()
    };
  }
  const { saveState } = await import("./lib/state.mjs");
  saveState(workspaceRoot, state);

  // Kill the process if we have a PID.
  if (job.pid) {
    const { terminateProcessTree } = await import("./lib/process.mjs");
    try {
      terminateProcessTree(job.pid);
    } catch {
      // Ignore.
    }
  }

  const nextJob = {
    ...job,
    status: "cancelled"
  };

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    turnInterruptAttempted: interrupt.attempted,
    turnInterrupted: interrupt.interrupted
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

// ─── Resume Candidate ─────────────────────────────────────────────────────────

async function handleTaskResumeCandidate(argv) {
  const { options } = parseArgs(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const candidate = await findLatestTaskThread(cwd);
  const payload = candidate ?? { id: null, status: null };
  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

// ─── Background Helpers ───────────────────────────────────────────────────────

function runReviewInBackground(workspaceRoot, options, kind) {
  const job = createTrackedJob({
    workspaceRoot,
    kind,
    title: `${kind}: ${options.scope ?? "auto"} review`,
    request: {
      scope: options.scope,
      base: options.base,
      model: resolveModel(options.model),
      focus: options.focus
    }
  });

  spawnBackgroundWorker(workspaceRoot, job.id);

  const payload = {
    jobId: job.id,
    status: "queued",
    message: `Background ${kind} started. Run /gemini:status ${job.id} to check progress.`
  };

  outputCommandResult(
    payload,
    `Background ${kind} started: ${job.id}\nRun /gemini:status ${job.id} to check progress.\n`,
    options.json
  );
}

function runTaskInBackground(workspaceRoot, request) {
  const job = createTrackedJob({
    workspaceRoot,
    kind: "task",
    title: buildPersistentTaskThreadName(request.prompt),
    request
  });

  spawnBackgroundWorker(workspaceRoot, job.id);

  const payload = {
    jobId: job.id,
    status: "queued",
    message: `Background task started. Run /gemini:status ${job.id} to check progress.`
  };

  outputCommandResult(
    payload,
    `Background task started: ${job.id}\nRun /gemini:status ${job.id} to check progress.\n`,
    request.json
  );
}

function spawnBackgroundWorker(workspaceRoot, jobId) {
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn("node", [scriptPath, "task-worker", jobId], {
    cwd: workspaceRoot,
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env
  });
  child.unref();
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    case "task-resume-candidate":
      await handleTaskResumeCandidate(argv);
      break;
    default:
      process.stderr.write(`Unknown subcommand: ${subcommand}\n`);
      printUsage();
      process.exit(1);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
