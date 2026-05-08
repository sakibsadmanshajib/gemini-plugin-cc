/**
 * Audit middleware — append-only JSONL log of every request, response,
 * notification, and health transition flowing through the chain.
 *
 * Position: AFTER redaction (any chain index ≥ 1). Every payload audit
 * sees has already been through redaction, so the on-disk log never
 * contains raw secrets.
 *
 * Storage: one JSONL file per session, under `~/.acp-plugins/audit/<session>/audit.jsonl`.
 * Append-only — never truncated mid-session. Rotation/retention is out of
 * this middleware's scope; the user is responsible for their own disk
 * hygiene (or the v2.x release adds a sidecar reaper).
 *
 * Record shape:
 *   { t: ISO-8601 timestamp, kind: "request" | "response" | "notify" | "health", payload: any }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * @typedef {import("./compose.mjs").Middleware} Middleware
 *
 * @typedef {{
 *   sessionId?: string,
 *   directory?: string,
 *   enabled?: boolean
 * }} AuditConfig
 */

const DEFAULT_DIR = path.join(os.homedir(), ".acp-plugins", "audit");

/**
 * @param {AuditConfig} [userConfig]
 * @returns {Middleware}
 */
export function createAuditMiddleware(userConfig = {}) {
  const sessionId =
    userConfig.sessionId ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const baseDir = userConfig.directory ?? DEFAULT_DIR;
  const enabled = userConfig.enabled ?? true;

  /** @type {number | null} */
  let fd = null;

  function ensureFd() {
    if (!enabled || fd !== null) return fd;
    try {
      const dir = path.join(baseDir, sessionId);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fd = fs.openSync(path.join(dir, "audit.jsonl"), "a");
    } catch {
      // Audit failures must not break the runtime — log to stderr and disable.
      process.stderr.write("[audit] failed to open log; auditing disabled\n");
    }
    return fd;
  }

  function record(kind, payload) {
    const handle = ensureFd();
    if (handle === null) return;
    try {
      const line = JSON.stringify({
        t: new Date().toISOString(),
        sessionId,
        kind,
        payload
      });
      fs.writeSync(handle, line + "\n");
    } catch {
      // Best-effort.
    }
  }

  return {
    name: "audit",
    wrap(next) {
      return {
        async start() {
          await next.start();
          record("health", "started");
        },
        async request(method, params) {
          record("request", { method, params });
          try {
            const result = await next.request(method, params);
            record("response", { method, result });
            return result;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            record("response", { method, error: message });
            throw err;
          }
        },
        notify(method, params) {
          record("notify", { method, params });
          next.notify(method, params);
        },
        onNotification(handler) {
          return next.onNotification((notification) => {
            record("inbound", notification);
            handler(notification);
          });
        },
        onHealthChange(handler) {
          return next.onHealthChange((state) => {
            record("health", state);
            handler(state);
          });
        },
        healthState() {
          return next.healthState();
        },
        async close() {
          record("health", "closing");
          try {
            await next.close();
          } finally {
            if (fd !== null) {
              try {
                fs.closeSync(fd);
              } catch {
                // Already closed.
              }
              fd = null;
            }
          }
        },
        isOpen() {
          return next.isOpen();
        }
      };
    }
  };
}
