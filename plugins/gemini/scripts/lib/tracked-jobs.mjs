/**
 * Job lifecycle tracking. Wraps a runner function with state persistence
 * and progress logging.
 */

import fs from "node:fs";
import process from "node:process";

import { withJobMutex } from "./atomic-state.mjs";
import {
  readJobFile,
  resolveJobLogFile,
  writeJobFile,
  writeJobFileUnlocked
} from "./state.mjs";
import {
  normalizeAndAppendEvent,
  upsertCompactJobIndexEntry
} from "./job-observability.mjs";

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
 * Atomically merge a state patch into a job file AND append a lifecycle event
 * (if provided) AND refresh the compact index entry — all under the same
 * per-job mutex hold. This collapses the previous
 * `writeJobFile + upsertCompactJobIndexEntry + safeRecordJobEvent` triple
 * into a single cycle, which prevents the index from being rewritten a
 * second time without the caller's lifecycle fields (e.g. `summary`).
 *
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {object} patch - Fields to merge over the existing job record.
 * @param {object|null} [event] - Optional event to append; falsy means skip.
 * @returns {Promise<{ job: object, eventRecorded: boolean }>}
 */
export async function persistJobStateAndEvent(workspaceRoot, jobId, patch, event) {
  return withJobMutex(workspaceRoot, jobId, async () => {
    const existing = readJobFile(workspaceRoot, jobId) ?? { id: jobId };
    const merged = { ...existing, ...patch };
    let eventRecorded = false;
    if (event) {
      const appended = normalizeAndAppendEvent(merged, event);
      Object.assign(merged, appended);
      eventRecorded = true;
    }
    writeJobFileUnlocked(workspaceRoot, jobId, merged);
    await upsertCompactJobIndexEntry(workspaceRoot, merged);
    return { job: merged, eventRecorded };
  });
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
  await persistJobStateAndEvent(
    job.workspaceRoot,
    job.id,
    {
      status: "running",
      startedAt,
      phase: "starting",
      pid: process.pid,
      logFile: options.logFile ?? job.logFile ?? null,
      healthStatus: "active",
      updatedAt: startedAt
    },
    {
      type: "worker_started",
      message: "Worker started.",
      timestamp: startedAt
    }
  );

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    await persistJobStateAndEvent(
      job.workspaceRoot,
      job.id,
      {
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        pid: null,
        phase: completionStatus === "completed" ? "done" : "failed",
        completedAt,
        updatedAt: completedAt,
        healthStatus: completionStatus,
        summary: execution.summary,
        result: execution.payload,
        rendered: execution.rendered
      },
      {
        type: completionStatus,
        message: completionStatus === "completed" ? "Job completed." : "Job failed.",
        timestamp: completedAt
      }
    );
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failedAt = nowIso();
    await persistJobStateAndEvent(
      job.workspaceRoot,
      job.id,
      {
        status: "failed",
        phase: "failed",
        pid: null,
        completedAt: failedAt,
        updatedAt: failedAt,
        healthStatus: "failed",
        errorMessage,
        summary: `Failed: ${errorMessage.slice(0, 120)}`
      },
      {
        type: "failed",
        message: errorMessage,
        timestamp: failedAt
      }
    );
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
    await persistJobStateAndEvent(
      workspaceRoot,
      jobId,
      { phase, updatedAt },
      {
        type: "phase_changed",
        phase,
        message: `Phase changed to ${phase}.`,
        timestamp: updatedAt
      }
    );
  }
}

export async function markTrackedJobCancelled(workspaceRoot, jobId, patch = {}) {
  const existing = readStoredJobOrNull(workspaceRoot, jobId);
  if (!existing) {
    return null;
  }

  const completedAt = patch.completedAt ?? nowIso();
  const message = patch.message ?? "Job cancelled.";
  // Merge caller's patch first, then force cancellation fields last so
  // callers cannot override status/phase/healthStatus/pid.
  const mergedPatch = {
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
  return persistJobStateAndEvent(
    workspaceRoot,
    jobId,
    mergedPatch,
    {
      type: "worker_cancelled",
      message,
      source: patch.source,
      timestamp: completedAt
    }
  );
}
