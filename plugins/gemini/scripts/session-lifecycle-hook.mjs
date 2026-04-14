#!/usr/bin/env node

/**
 * Session lifecycle hook — handles SessionStart and SessionEnd events.
 *
 * SessionStart: Exports GEMINI_COMPANION_SESSION_ID and CLAUDE_PLUGIN_DATA
 *   into the Claude session via CLAUDE_ENV_FILE.
 *
 * SessionEnd: Shuts down the broker, cleans up session jobs.
 */

import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process.mjs";
import { BROKER_ENDPOINT_ENV } from "./lib/acp-client.mjs";
import {
  clearBrokerSession,
  LOG_FILE_ENV,
  loadBrokerSession,
  PID_FILE_ENV,
  sendBrokerShutdown,
  teardownBrokerSession
} from "./lib/broker-lifecycle.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "GEMINI_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId)
  });
}

async function handleSessionStart(input) {
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  // Generate a unique session ID.
  const sessionId = `gemini-session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Export session env vars.
  appendEnvVar(SESSION_ID_ENV, sessionId);

  if (process.env[PLUGIN_DATA_ENV]) {
    appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
  }

  // Also export broker-related env vars if a broker session exists.
  const brokerSession = loadBrokerSession(cwd);
  if (brokerSession) {
    appendEnvVar(BROKER_ENDPOINT_ENV, brokerSession.endpoint);
    if (brokerSession.pidFile) {
      appendEnvVar(PID_FILE_ENV, brokerSession.pidFile);
    }
    if (brokerSession.logFile) {
      appendEnvVar(LOG_FILE_ENV, brokerSession.logFile);
    }
  }
}

async function handleSessionEnd(input) {
  const cwd = input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  const sessionId = process.env[SESSION_ID_ENV] ?? null;

  // Shut down the broker.
  const brokerSession = loadBrokerSession(cwd);
  if (brokerSession) {
    await sendBrokerShutdown(brokerSession.endpoint);
    teardownBrokerSession({
      endpoint: brokerSession.endpoint,
      pidFile: brokerSession.pidFile,
      logFile: brokerSession.logFile,
      sessionDir: brokerSession.sessionDir,
      pid: brokerSession.pid,
      killProcess: terminateProcessTree
    });
    clearBrokerSession(cwd);
  }

  // Clean up session jobs.
  cleanupSessionJobs(cwd, sessionId);
}

async function main() {
  const event = process.argv[2];
  const input = readHookInput();

  switch (event) {
    case "SessionStart":
      await handleSessionStart(input);
      break;
    case "SessionEnd":
      await handleSessionEnd(input);
      break;
    default:
      process.stderr.write(`Unknown lifecycle event: ${event}\n`);
      break;
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  // Hooks should not cause Claude to fail — exit cleanly.
}
