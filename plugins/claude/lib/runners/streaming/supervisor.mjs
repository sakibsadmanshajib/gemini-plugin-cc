/**
 * Streaming runner supervisor — generic lifecycle wrapper around any
 * `StreamingRunner`.
 *
 * The supervisor owns:
 *   - lazy `start()` (deferred until the first runTurn call)
 *   - idle reaping (close the runner after N ms of no activity)
 *   - bounded restart on transient failure
 *   - health label aggregation (so callers can probe "is it alive?")
 *
 * Per-backend runners (`gemini-streaming.mjs`, future codex/claude
 * variants) handle the protocol details. The supervisor is the same
 * for all of them — keeping the lifecycle math in one place.
 *
 * Design notes:
 *   - We do NOT auto-start in the constructor. The first runTurn() call
 *     starts the underlying runner. This avoids spawning processes on
 *     module load.
 *   - Idle timer is reset on each successful runTurn(). When it fires,
 *     close() is called and the supervisor returns to the pre-start
 *     state. The next runTurn() starts a fresh runner.
 *   - Restart budget protects against thrash: if the runner crashes
 *     more than `maxRestarts` times within `restartWindowMs`, the
 *     supervisor declares the backend dead and rejects subsequent
 *     turns until it's manually closed.
 *
 * @typedef {import("./types.mjs").StreamingRunner} StreamingRunner
 * @typedef {import("./types.mjs").StreamingHealth} StreamingHealth
 * @typedef {import("./types.mjs").StreamingTurnOptions} StreamingTurnOptions
 * @typedef {import("./types.mjs").TurnResult} TurnResult
 *
 * @typedef {{
 *   factory: () => StreamingRunner,
 *   idleMs?: number,
 *   maxRestarts?: number,
 *   restartWindowMs?: number,
 *   onWarning?: (msg: string) => void
 * }} SupervisorOptions
 */

const DEFAULT_IDLE_MS = 60_000; // 60s of inactivity → reap
const DEFAULT_MAX_RESTARTS = 3;
const DEFAULT_RESTART_WINDOW_MS = 60_000;

/**
 * Create a supervisor wrapping the given runner factory. The supervisor
 * itself implements the `StreamingRunner` interface so callers can use
 * it interchangeably.
 *
 * @param {SupervisorOptions} opts
 * @returns {StreamingRunner & { _restartCount: () => number }}
 */
export function createSupervisor(opts) {
  if (!opts || typeof opts.factory !== "function") {
    throw new TypeError("createSupervisor: opts.factory is required");
  }
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
  const restartWindowMs = opts.restartWindowMs ?? DEFAULT_RESTART_WINDOW_MS;
  const onWarning = opts.onWarning ?? noop;

  /** @type {StreamingRunner | null} */
  let runner = null;
  /** @type {NodeJS.Timeout | null} */
  let idleTimer = null;
  /** @type {Promise<void> | null} */
  let startPromise = null;
  /** @type {number[]} */
  const restartTimestamps = [];
  let dead = false;

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer() {
    clearIdleTimer();
    if (idleMs <= 0) return;
    idleTimer = setTimeout(() => {
      void closeInner("idle reap");
    }, idleMs);
    if (typeof idleTimer.unref === "function") idleTimer.unref();
  }

  /** @param {number} ts */
  function inWindow(ts) {
    return ts >= Date.now() - restartWindowMs;
  }

  function recordRestart() {
    const now = Date.now();
    restartTimestamps.push(now);
    while (restartTimestamps.length > 0 && !inWindow(restartTimestamps[0])) {
      restartTimestamps.shift();
    }
    return restartTimestamps.length;
  }

  async function startInner() {
    if (dead) {
      throw new Error("supervisor: runner is dead (max restarts exceeded)");
    }
    if (runner) return;
    if (startPromise) return startPromise;

    runner = opts.factory();
    const r = runner;
    startPromise = (async () => {
      try {
        await r.start();
      } catch (err) {
        runner = null;
        startPromise = null;
        throw err;
      }
    })();
    try {
      await startPromise;
    } finally {
      startPromise = null;
    }
  }

  /** @param {string} reason */
  async function closeInner(reason) {
    clearIdleTimer();
    const current = runner;
    runner = null;
    startPromise = null;
    if (current) {
      try {
        await current.close();
      } catch (err) {
        onWarning(
          `supervisor: close failed during ${reason}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /** @type {StreamingRunner & { _restartCount: () => number }} */
  const supervisor = {
    async start() {
      await startInner();
      armIdleTimer();
    },

    async runTurn(turnOpts, context) {
      if (dead) {
        throw new Error("supervisor: runner is dead (max restarts exceeded)");
      }
      // Lazy start
      if (!runner) {
        await startInner();
      }
      armIdleTimer();
      try {
        const result = await /** @type {StreamingRunner} */ (runner).runTurn(turnOpts, context);
        armIdleTimer();
        return result;
      } catch (err) {
        // If the underlying runner is no longer healthy, close + retry
        // within the restart budget.
        const wrapped = runner;
        const wrappedHealth = wrapped ? wrapped.health() : "dead";
        if (wrappedHealth === "dead" || wrappedHealth === "restarting") {
          const count = recordRestart();
          await closeInner("restart attempt");
          if (count > maxRestarts) {
            dead = true;
            onWarning(
              `supervisor: exceeded ${maxRestarts} restarts in ${restartWindowMs}ms — declaring dead`
            );
          }
        }
        throw err;
      }
    },

    async close() {
      await closeInner("explicit close");
      // close() does NOT clear the dead flag — caller must construct a
      // fresh supervisor to reset.
    },

    health() {
      if (dead) return "dead";
      if (!runner && !startPromise) return "starting"; // pre-first-turn
      if (startPromise) return "starting";
      // Defer to the underlying runner; degraded turns leave lastWrappedHealth set.
      return /** @type {StreamingRunner} */ (runner).health();
    },

    /**
     * Test-only: number of restarts recorded inside the current window.
     */
    _restartCount() {
      return restartTimestamps.length;
    }
  };

  return supervisor;
}

function noop() {
  /* placeholder */
}
