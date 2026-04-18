import { withJobMutex } from "./atomic-state.mjs";
import { loadState, readJobFile, saveState, writeJobFile, writeJobFileUnlocked } from "./state.mjs";

export const MAX_JOB_EVENTS = 50;
export const MAX_DIAGNOSTIC_LENGTH = 500;

const PROGRESS_EVENT_TYPES = new Set([
  "model_text_chunk",
  "tool_call",
  "file_change",
  "phase",
  "phase_changed",
  "status",
  "worker_started"
]);
const DIAGNOSTIC_EVENT_TYPES = new Set(["diagnostic", "error", "stderr"]);
const SAFE_EVENT_FIELDS = new Set([
  "type",
  "timestamp",
  "message",
  "phase",
  "toolName",
  "path",
  "action",
  "source",
  "transport"
]);

function nowIso() {
  return new Date().toISOString();
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function sanitizeEvent(event, timestamp) {
  const input = event && typeof event === "object" ? event : {};
  const normalized = { timestamp: sanitizeText(timestamp) };
  for (const [key, value] of Object.entries(input)) {
    if (SAFE_EVENT_FIELDS.has(key) && typeof value === "string") {
      normalized[key] = sanitizeText(value);
    }
  }
  return normalized;
}

function recommendedActionFor(kind) {
  switch (kind) {
    case "rate_limit":
      return "Wait for quota recovery or reduce request volume.";
    case "auth":
      return "Refresh Gemini authentication before retrying.";
    case "broker":
      return "Restart or reconnect the Gemini broker.";
    case "model":
      return "Check model availability or retry with a supported model.";
    case "network":
      return "Check network connectivity and retry.";
    default:
      return "Review the latest diagnostic event.";
  }
}

function isDiagnosticEvent(event) {
  const type = String(event.type ?? "");
  return DIAGNOSTIC_EVENT_TYPES.has(type) || type.includes("diagnostic") || type.includes("error");
}

function isProgressEvent(event) {
  return PROGRESS_EVENT_TYPES.has(String(event.type ?? ""));
}

function compactJobIndexEntry(job) {
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    sessionId: job.sessionId,
    workspaceRoot: job.workspaceRoot,
    logFile: job.logFile,
    threadId: job.threadId,
    turnId: job.turnId,
    summary: job.summary,
    errorMessage: job.errorMessage,
    pid: job.pid,
    phase: job.phase,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
    healthStatus: job.healthStatus,
    healthMessage: job.healthMessage,
    recommendedAction: job.recommendedAction,
    lastHeartbeatAt: job.lastHeartbeatAt,
    lastProgressAt: job.lastProgressAt,
    lastModelOutputAt: job.lastModelOutputAt,
    lastToolCallAt: job.lastToolCallAt,
    lastDiagnosticAt: job.lastDiagnosticAt
  };
}

/**
 * Pure helper: compute the patch (events array + derived progress/health
 * fields) that would result from appending `event` to `job`. Does NOT mutate
 * `job` and does NOT perform any I/O. Callers that already hold the per-job
 * mutex can merge this patch into the existing record and write atomically.
 */
export function normalizeAndAppendEvent(job, event) {
  const timestamp = event?.timestamp ?? nowIso();
  const normalizedEvent = sanitizeEvent(event, timestamp);
  const persistedTimestamp = normalizedEvent.timestamp;
  const events = [
    ...(Array.isArray(job?.events) ? job.events : []),
    normalizedEvent
  ].slice(-MAX_JOB_EVENTS);
  const patch = {
    events,
    lastHeartbeatAt: persistedTimestamp,
    updatedAt: nowIso()
  };

  if (isProgressEvent(normalizedEvent)) {
    patch.lastProgressAt = persistedTimestamp;
    patch.healthStatus = "active";
  }

  if (normalizedEvent.type === "model_text_chunk") {
    patch.lastModelOutputAt = persistedTimestamp;
  }

  if (normalizedEvent.type === "tool_call") {
    patch.lastToolCallAt = persistedTimestamp;
  }

  if (isDiagnosticEvent(normalizedEvent)) {
    const healthMessage = sanitizeText(normalizedEvent.message);
    const classification = classifyDiagnostic(healthMessage);
    patch.lastDiagnosticAt = persistedTimestamp;
    patch.healthStatus =
      classification.kind === "unknown" && String(normalizedEvent.type ?? "").includes("error")
        ? "possibly_stalled"
        : classification.healthStatus;
    patch.healthMessage = healthMessage;
    patch.recommendedAction = recommendedActionFor(classification.kind);
  }

  if (normalizedEvent.type === "completed") {
    patch.healthStatus = "completed";
    patch.recommendedAction = "Run /gemini:result to inspect the completed job output.";
  }

  if (normalizedEvent.type === "failed") {
    patch.healthStatus = "failed";
    patch.healthMessage = sanitizeText(normalizedEvent.message);
    patch.recommendedAction = "Check /gemini:status or /gemini:result for details before retrying.";
  }

  if (normalizedEvent.type === "worker_cancelled" || normalizedEvent.type === "cancelled") {
    patch.healthStatus = "cancelled";
    patch.healthMessage = sanitizeText(normalizedEvent.message);
    patch.recommendedAction = "Check /gemini:status or /gemini:result, then retry if the result is incomplete.";
  }

  return patch;
}

export async function upsertCompactJobIndexEntry(workspaceRoot, job) {
  const state = loadState(workspaceRoot);
  const compact = compactJobIndexEntry(job);
  const index = state.jobs.findIndex((entry) => entry.id === job.id);
  if (index >= 0) {
    state.jobs[index] = compact;
  } else {
    state.jobs.push(compact);
  }
  await saveState(workspaceRoot, state);
}

export function classifyDiagnostic(text) {
  const value = String(text ?? "");
  const lower = value.toLowerCase();
  if (/(rate limit|quota|429|resource exhausted)/.test(lower)) {
    return { kind: "rate_limit", healthStatus: "rate_limited" };
  }
  if (/(auth|credential|login|unauthorized|401|permission denied)/.test(lower)) {
    return { kind: "auth", healthStatus: "auth_required" };
  }
  if (/(broker|socket|endpoint|busy|disconnected|not ready)/.test(lower)) {
    return { kind: "broker", healthStatus: "broker_unhealthy" };
  }
  if (/(model.*unavailable|unavailable.*model|not found.*model)/.test(lower)) {
    return { kind: "model", healthStatus: "possibly_stalled" };
  }
  if (/(econnreset|etimedout|network|dns|api error|connection)/.test(lower)) {
    return { kind: "network", healthStatus: "possibly_stalled" };
  }
  return { kind: "unknown", healthStatus: "quiet" };
}

export async function recordJobEvent(workspaceRoot, jobId, event) {
  return withJobMutex(workspaceRoot, jobId, async () => {
    const existing = readJobFile(workspaceRoot, jobId);
    if (!existing) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const patch = normalizeAndAppendEvent(existing, event);
    const nextJob = { ...existing, ...patch };
    // We already hold the per-job mutex; use the unlocked write helper to
    // avoid the non-reentrant re-acquire that would otherwise deadlock.
    writeJobFileUnlocked(workspaceRoot, jobId, nextJob);
    // The workspace mutex used by upsertCompactJobIndexEntry is a different
    // key, so it cannot deadlock against the per-job mutex we hold here.
    await upsertCompactJobIndexEntry(workspaceRoot, nextJob);

    return nextJob;
  });
}
