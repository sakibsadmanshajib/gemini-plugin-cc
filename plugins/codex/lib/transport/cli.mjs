/**
 * CliTransport — subprocess-backed AcpSession.
 *
 * Spawns a CLI process, frames JSON-RPC over its stdio, and exposes the
 * `ClientTransport` shape that `lib/acp/client.mjs::createAcpClient` consumes.
 *
 * Health states (transitioning into `lib/acp/types.mjs::HealthState`):
 *
 *   - `queued`            — created but not started
 *   - `active`            — started, child running, recent activity
 *   - `quiet`             — running but no events for >15s
 *   - `worker_missing`    — child exited unexpectedly
 *   - `failed` / `cancelled` / `completed` — terminal states from the runtime
 *
 * Lifecycle:
 *   1. `start()` spawns the child and resolves once stdio is wired.
 *   2. `send(message)` writes a frame to stdin.
 *   3. `onMessage(handler)` delivers parsed inbound frames.
 *   4. `close()` sends SIGTERM, waits up to SHUTDOWN_GRACE_MS, then SIGKILL.
 *
 * Crash detection: if the child exits while the transport is open, health
 * transitions to `worker_missing` and `isOpen()` returns false. Pending
 * client requests should fail (the higher-level client handles that — see
 * `createAcpClient`'s pending map).
 *
 * **Error-message contract (round-16 lock-in).** The "CliTransport
 * (<command>): stdin unavailable" string thrown when stdin is missing
 * is byte-exact-locked in `tests/unit/streaming-registry.test.mjs` —
 * it maps to the `transport_closed` LastErrorCode bucket. Rewording
 * it (e.g. "stdin pipe not available") will fail the specific
 * lock-in test; update the matching test case in lockstep with the
 * source change.
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { createLineBuffer, frame } from "../acp/framing.mjs";
import { openWireLog } from "../wire-log.mjs";

const SHUTDOWN_GRACE_MS = 5000;
const QUIET_AFTER_MS = 15000;

/**
 * @typedef {import("../acp/types.mjs").HealthState} HealthState
 * @typedef {import("../acp/types.mjs").JsonRpcMessage} JsonRpcMessage
 * @typedef {import("../acp/client.mjs").ClientTransport} ClientTransport
 */

/**
 * @param {{
 *   command: string,
 *   args?: string[],
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   quietAfterMs?: number,
 *   wireLog?: ReturnType<typeof openWireLog>
 * }} options
 * @returns {ClientTransport}
 */
export function createCliTransport(options) {
  const { command, args = [], env = process.env, cwd = process.cwd() } = options;
  const quietMs = options.quietAfterMs ?? QUIET_AFTER_MS;
  const wireLog = options.wireLog ?? openWireLog();

  const events = new EventEmitter();
  const buffer = createLineBuffer();

  /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
  let child = null;
  /** @type {HealthState} */
  let health = "queued";
  /** @type {NodeJS.Timeout | null} */
  let quietTimer = null;
  let starting = false;
  let started = false;
  let closing = false;

  function setHealth(next) {
    if (health === next) return;
    health = next;
    events.emit("health", next);
  }

  function bumpActivity() {
    setHealth("active");
    if (quietTimer) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => {
      // Only demote to quiet if the child is still running; terminal states
      // (worker_missing / completed / failed / cancelled) are sticky.
      if (health === "active") setHealth("quiet");
    }, quietMs);
    quietTimer.unref?.();
  }

  function emitMessage(line) {
    /** @type {JsonRpcMessage | null} */
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed) return;
    wireLog.record("in", parsed);
    bumpActivity();
    events.emit("message", parsed);
  }

  return {
    async start() {
      if (started || starting) return;
      starting = true;
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"]
      });
      started = true;
      starting = false;
      setHealth("active");

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        for (const line of buffer.feed(chunk)) emitMessage(line);
      });

      // Stderr goes to the parent's stderr — diagnostic only, never wire.
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        process.stderr.write(`[${command} stderr] ${chunk}`);
      });

      child.on("exit", (code, signal) => {
        if (closing) {
          setHealth(code === 0 ? "completed" : "cancelled");
        } else {
          // Unexpected exit — the worker is gone.
          setHealth("worker_missing");
          process.stderr.write(
            `[${command}] exited unexpectedly (code=${code} signal=${signal})\n`
          );
        }
        started = false;
        if (quietTimer) clearTimeout(quietTimer);
      });

      child.on("error", (err) => {
        process.stderr.write(`[${command}] error: ${err.message}\n`);
        setHealth("worker_missing");
      });
    },

    send(message) {
      if (!child?.stdin || child.stdin.destroyed) {
        throw new Error(`CliTransport (${command}): stdin unavailable`);
      }
      wireLog.record("out", message);
      child.stdin.write(frame(message));
      bumpActivity();
    },

    onMessage(handler) {
      events.on("message", handler);
    },

    onHealthChange(handler) {
      events.on("health", handler);
    },

    healthState() {
      return health;
    },

    async close() {
      if (!started || closing) return;
      closing = true;
      const proc = child;
      if (!proc || proc.exitCode !== null) return;

      proc.stdin?.end();
      proc.kill("SIGTERM");

      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (proc.exitCode === null) {
            try {
              proc.kill("SIGKILL");
            } catch {
              // Already gone.
            }
          }
          resolve();
        }, SHUTDOWN_GRACE_MS);
        timer.unref?.();
        proc.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },

    isOpen() {
      return started && !closing && child !== null && child.exitCode === null;
    }
  };
}
