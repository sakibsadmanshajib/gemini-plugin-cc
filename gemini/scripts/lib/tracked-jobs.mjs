/**
 * Job lifecycle tracking. Wraps a runner function with state persistence
 * and progress logging.
 */

import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "GEMINI_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function appendLogBlock(logFile, title, content) {
  if (!logFile || !content) {
    return;
  }
  const timestamp = new Date().toISOString();
  const block = `\n--- ${title} [${timestamp}] ---\n${content}\n`;
  try {
    fs.appendFileSync(logFile, block, "utf8");
  } catch {
    // Ignore log write failures.
  }
}

function readStoredJobOrNull(cwd, jobId) {
  try {
    return readJobFile(cwd, jobId);
  } catch {
    return null;
  }
}

/**
 * Create a tracked job record.
 *
 * @param {{ workspaceRoot: string, kind: string, title: string, request?: any }} params
 * @returns {object}
 */
export function createTrackedJob({ workspaceRoot, kind, title, request }) {
  const id = `gemini-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = process.env[SESSION_ID_ENV] ?? null;
  const logFile = resolveJobLogFile(workspaceRoot, id);

  const job = {
    id,
    kind,
    title,
    status: "queued",
    sessionId,
    workspaceRoot,
    logFile,
    request: request ?? null,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  writeJobFile(workspaceRoot, id, job);
  upsertJob(workspaceRoot, job);

  return job;
}

/**
 * Run a tracked job, persisting state transitions (queued -> running -> completed/failed).
 *
 * @param {object} job - The job record from createTrackedJob.
 * @param {() => Promise<{ exitStatus: number, threadId?: string, turnId?: string, payload?: any, rendered?: string, summary?: string }>} runner
 * @param {{ logFile?: string }} [options]
 */
export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const failedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: failedAt,
      errorMessage
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: failedAt,
      summary: `Failed: ${errorMessage.slice(0, 120)}`
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Error", errorMessage);
    throw error;
  }
}

/**
 * Update a running job's phase for progress reporting.
 *
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {string} phase
 */
export function updateJobPhase(workspaceRoot, jobId, phase) {
  const existing = readStoredJobOrNull(workspaceRoot, jobId);
  if (existing && existing.status === "running") {
    writeJobFile(workspaceRoot, jobId, { ...existing, phase, updatedAt: nowIso() });
    upsertJob(workspaceRoot, { id: jobId, phase, updatedAt: nowIso() });
  }
}
