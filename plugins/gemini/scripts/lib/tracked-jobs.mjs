/**
 * Job lifecycle tracking. Wraps a runner function with state persistence
 * and progress logging.
 */

import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobLogFile, writeJobFile } from "./state.mjs";
import { recordJobEvent, upsertCompactJobIndexEntry } from "./job-observability.mjs";

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

async function safeRecordJobEvent(workspaceRoot, jobId, event) {
  try {
    return await recordJobEvent(workspaceRoot, jobId, event);
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
export async function createTrackedJob({ workspaceRoot, kind, title, request }) {
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
    events: [],
    healthStatus: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  await writeJobFile(workspaceRoot, id, job);
  await upsertCompactJobIndexEntry(workspaceRoot, job);

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
  const startedAt = nowIso();
  const runningRecord = {
    ...job,
    status: "running",
    startedAt,
    phase: "starting",
    pid: process.pid,
    logFile: options.logFile ?? job.logFile ?? null,
    healthStatus: "active",
    updatedAt: startedAt
  };
  await writeJobFile(job.workspaceRoot, job.id, runningRecord);
  await upsertCompactJobIndexEntry(job.workspaceRoot, runningRecord);
  await safeRecordJobEvent(job.workspaceRoot, job.id, {
    type: "worker_started",
    message: "Worker started.",
    timestamp: startedAt
  });

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    await writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      completedAt,
      updatedAt: completedAt,
      healthStatus: completionStatus,
      result: execution.payload,
      rendered: execution.rendered
    });
    await upsertCompactJobIndexEntry(job.workspaceRoot, {
      ...existing,
      id: job.id,
      kind: existing.kind ?? job.kind,
      title: existing.title ?? job.title,
      status: completionStatus,
      sessionId: existing.sessionId ?? job.sessionId,
      workspaceRoot: existing.workspaceRoot ?? job.workspaceRoot,
      logFile: existing.logFile ?? options.logFile ?? job.logFile ?? null,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : "failed",
      pid: null,
      completedAt,
      updatedAt: completedAt,
      healthStatus: completionStatus
    });
    await safeRecordJobEvent(job.workspaceRoot, job.id, {
      type: completionStatus,
      message: completionStatus === "completed" ? "Job completed." : "Job failed.",
      timestamp: completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const failedAt = nowIso();
    await writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: failedAt,
      updatedAt: failedAt,
      healthStatus: "failed",
      errorMessage
    });
    await upsertCompactJobIndexEntry(job.workspaceRoot, {
      ...existing,
      id: job.id,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt: failedAt,
      updatedAt: failedAt,
      healthStatus: "failed",
      summary: `Failed: ${errorMessage.slice(0, 120)}`
    });
    await safeRecordJobEvent(job.workspaceRoot, job.id, {
      type: "failed",
      message: errorMessage,
      timestamp: failedAt
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
export async function updateJobPhase(workspaceRoot, jobId, phase) {
  const existing = readStoredJobOrNull(workspaceRoot, jobId);
  if (existing && existing.status === "running") {
    const updatedAt = nowIso();
    const nextJob = { ...existing, phase, updatedAt };
    await writeJobFile(workspaceRoot, jobId, nextJob);
    await upsertCompactJobIndexEntry(workspaceRoot, nextJob);
    await safeRecordJobEvent(workspaceRoot, jobId, {
      type: "phase_changed",
      phase,
      message: `Phase changed to ${phase}.`,
      timestamp: updatedAt
    });
  }
}

export async function markTrackedJobCancelled(workspaceRoot, jobId, patch = {}) {
  const existing = readStoredJobOrNull(workspaceRoot, jobId);
  if (!existing) {
    return null;
  }

  const completedAt = patch.completedAt ?? nowIso();
  const message = patch.message ?? "Job cancelled.";
  const nextJob = {
    ...existing,
    ...patch,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    updatedAt: completedAt,
    healthStatus: "cancelled",
    healthMessage: message,
    recommendedAction: "Check /gemini:status or /gemini:result, then retry if the result is incomplete."
  };
  await writeJobFile(workspaceRoot, jobId, nextJob);
  await upsertCompactJobIndexEntry(workspaceRoot, nextJob);
  const recorded = await safeRecordJobEvent(workspaceRoot, jobId, {
    type: "worker_cancelled",
    message,
    source: patch.source,
    timestamp: completedAt
  });
  return recorded ?? nextJob;
}
