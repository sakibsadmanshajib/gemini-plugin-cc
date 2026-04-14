#!/usr/bin/env node

/**
 * Stop review gate hook — optionally runs a Gemini adversarial review of
 * Claude's last response before allowing a session to stop.
 *
 * When enabled, this hook:
 * 1. Reads the previous Claude response from hook input
 * 2. Checks if Claude made code changes in that turn
 * 3. Sends the response to Gemini for review via ACP
 * 4. Returns ALLOW or BLOCK based on Gemini's assessment
 */

import fs from "node:fs";
import process from "node:process";

import { getGeminiAvailability, getGeminiAuthStatus, runAcpPrompt } from "./lib/gemini.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { loadPrompt } from "./lib/prompts.mjs";
import { loadBrokerSession } from "./lib/broker-lifecycle.mjs";
import { runCommand } from "./lib/process.mjs";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(decision) {
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}

function logNote(note) {
  if (note) {
    process.stderr.write(`${note}\n`);
  }
}

function buildSetupNote(cwd) {
  const { available } = getGeminiAvailability();
  if (!available) {
    return "Gemini CLI is not installed. Run /gemini:setup to install.";
  }
  return null;
}

function isRunningTask(cwd) {
  try {
    const jobs = listJobs(cwd);
    return jobs.some((j) => j.status === "running" || j.status === "queued");
  } catch {
    return false;
  }
}

function runStopReview(cwd, input) {
  const claudeResponse = input.stopHookInput?.claudeResponse ?? input.claude_response ?? "";

  if (!claudeResponse) {
    return { ok: true, reason: "No Claude response to review." };
  }

  // Load the stop-review-gate prompt template.
  const claudeResponseBlock = `<claude_response>\n${claudeResponse}\n</claude_response>`;
  const prompt = loadPrompt("stop-review-gate", {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });

  // Run the review synchronously via headless mode (hooks must be synchronous).
  const result = runCommand("gemini", ["-p", prompt, "--output-format", "text", "--approval-mode", "plan"], {
    cwd,
    maxBuffer: 5 * 1024 * 1024
  });

  if (result.error || result.status !== 0) {
    return {
      ok: false,
      reason: `Gemini review failed: ${result.stderr?.slice(0, 200) || "unknown error"}`
    };
  }

  const output = result.stdout.trim();
  const firstLine = output.split("\n")[0] ?? "";

  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: firstLine };
  }

  if (firstLine.startsWith("BLOCK:")) {
    return { ok: false, reason: firstLine };
  }

  // If the output doesn't match expected format, allow by default.
  return { ok: true, reason: `Gemini response did not match expected format. Allowing. First line: ${firstLine.slice(0, 100)}` };
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  let workspaceRoot;
  try {
    workspaceRoot = resolveWorkspaceRoot(cwd);
  } catch {
    // Not in a git repo — skip review.
    return;
  }

  const config = getConfig(workspaceRoot);

  // Check if there are running tasks — note this but don't block.
  let runningTaskNote = null;
  try {
    const jobs = listJobs(workspaceRoot);
    const active = jobs.filter((j) => j.status === "running" || j.status === "queued");
    if (active.length > 0) {
      runningTaskNote = `Note: ${active.length} Gemini job(s) still active. Run /gemini:status to check.`;
    }
  } catch {
    // Ignore.
  }

  // If review gate is disabled, just log the running task note.
  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(workspaceRoot);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(workspaceRoot, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  // Hooks should not cause Claude to fail — exit cleanly.
}
