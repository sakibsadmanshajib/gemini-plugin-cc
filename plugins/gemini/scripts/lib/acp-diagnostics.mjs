/**
 * Helpers for capturing and forwarding ACP runtime diagnostics as bounded,
 * sanitized messages. Used by both the direct SpawnedAcpClient and the ACP
 * broker to keep stderr chatter out of model output while still giving jobs
 * and status rendering visible context for quota, auth, and broker issues.
 */

export const MAX_DIAGNOSTIC_LENGTH = 500;
export const BROKER_DIAGNOSTIC_METHOD = "broker/diagnostic";

export function sanitizeDiagnosticMessage(value) {
  return String(value ?? "")
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\|$)/g, "")
    .replace(/\u001b[PX^_][\s\S]*?(?:\u001b\\|$)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DIAGNOSTIC_LENGTH);
}

export function buildBrokerDiagnosticNotification({ source, message }) {
  const sanitizedSource = sanitizeDiagnosticMessage(source ?? "broker") || "broker";
  return {
    jsonrpc: "2.0",
    method: BROKER_DIAGNOSTIC_METHOD,
    params: {
      source: sanitizedSource,
      message: sanitizeDiagnosticMessage(message)
    }
  };
}

export function createStderrDiagnosticCollector(emit) {
  let pending = "";
  return {
    feed(chunk) {
      pending += typeof chunk === "string" ? chunk : String(chunk ?? "");
      let newlineIndex;
      while ((newlineIndex = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        const sanitized = sanitizeDiagnosticMessage(line);
        if (sanitized) {
          try {
            emit(sanitized);
          } catch {
            // Best-effort telemetry — never let diagnostic delivery crash the ACP client.
          }
        }
      }
      if (pending.length > MAX_DIAGNOSTIC_LENGTH * 4) {
        // Line-less flood: emit a single synthetic marker and reset pending to
        // avoid leaking mid-line garbage (e.g. binary noise, tail-keep of a
        // truncated log stream).
        try {
          emit("[truncated diagnostic]");
        } catch {
          // Best-effort.
        }
        pending = "";
      }
    },
    flush() {
      if (pending.trim()) {
        const sanitized = sanitizeDiagnosticMessage(pending);
        pending = "";
        if (sanitized) {
          try {
            emit(sanitized);
          } catch {
            // Best-effort.
          }
        }
      }
    }
  };
}

export function attachStderrDiagnosticCollector(stream, emit) {
  const collector = createStderrDiagnosticCollector(emit);
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk) => collector.feed(chunk));
  const flush = () => collector.flush();
  stream.on("end", flush);
  stream.on("close", flush);
  return collector;
}
