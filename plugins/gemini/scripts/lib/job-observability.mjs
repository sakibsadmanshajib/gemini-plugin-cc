import { readJobFile, upsertJob, writeJobFile } from "./state.mjs";

export const MAX_JOB_EVENTS = 50;
export const MAX_DIAGNOSTIC_LENGTH = 500;

const PROGRESS_EVENT_TYPES = new Set(["model_text_chunk", "tool_call", "file_change", "phase", "status"]);
const DIAGNOSTIC_EVENT_TYPES = new Set(["diagnostic", "error", "stderr"]);

function nowIso() {
  return new Date().toISOString();
}

function sanitizeText(value) {
  return String(value ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function sanitizeEvent(event, timestamp) {
  const input = event && typeof event === "object" ? event : {};
  const normalized = { ...input, timestamp };
  for (const [key, value] of Object.entries(normalized)) {
    if (typeof value === "string") {
      normalized[key] = sanitizeText(value);
    }
  }
  return normalized;
}

function eventMessage(event) {
  return event.message ?? event.error ?? event.text ?? event.output ?? "";
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

export function classifyDiagnostic(text) {
  const value = String(text ?? "");
  const lower = value.toLowerCase();
  if (/(rate limit|quota|429|resource exhausted|retrying|backoff)/.test(lower)) {
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

export function recordJobEvent(workspaceRoot, jobId, event) {
  const existing = readJobFile(workspaceRoot, jobId);
  if (!existing) {
    throw new Error(`Job not found: ${jobId}`);
  }

  const timestamp = event?.timestamp ?? nowIso();
  const normalizedEvent = sanitizeEvent(event, timestamp);
  const events = [...(Array.isArray(existing.events) ? existing.events : []), normalizedEvent].slice(-MAX_JOB_EVENTS);
  const patch = {
    events,
    lastHeartbeatAt: timestamp,
    updatedAt: nowIso()
  };

  if (isProgressEvent(normalizedEvent)) {
    patch.lastProgressAt = timestamp;
    patch.healthStatus = "active";
  }

  if (normalizedEvent.type === "model_text_chunk") {
    patch.lastModelOutputAt = timestamp;
  }

  if (normalizedEvent.type === "tool_call") {
    patch.lastToolCallAt = timestamp;
  }

  if (isDiagnosticEvent(normalizedEvent)) {
    const healthMessage = sanitizeText(eventMessage(normalizedEvent));
    const classification = classifyDiagnostic(healthMessage);
    patch.lastDiagnosticAt = timestamp;
    patch.healthStatus = classification.healthStatus;
    patch.healthMessage = healthMessage;
    patch.recommendedAction = recommendedActionFor(classification.kind);
  }

  const nextJob = { ...existing, ...patch };
  writeJobFile(workspaceRoot, jobId, nextJob);
  upsertJob(workspaceRoot, {
    id: jobId,
    status: nextJob.status,
    phase: nextJob.phase,
    healthStatus: nextJob.healthStatus,
    healthMessage: nextJob.healthMessage,
    recommendedAction: nextJob.recommendedAction,
    lastHeartbeatAt: nextJob.lastHeartbeatAt,
    lastProgressAt: nextJob.lastProgressAt,
    lastModelOutputAt: nextJob.lastModelOutputAt,
    lastToolCallAt: nextJob.lastToolCallAt,
    lastDiagnosticAt: nextJob.lastDiagnosticAt
  });

  return nextJob;
}
