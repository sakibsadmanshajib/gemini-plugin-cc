/**
 * Legacy broker-lifecycle — stub. The gemini --acp broker daemon was
 * deleted in Step 5 of the unified-facade plan. This file kept its
 * surface for callers in the legacy gemini-companion path but every
 * function now no-ops or refuses safely.
 *
 * If a slash-command still imports from here, ensureBrokerSession()
 * returns null (the documented contract for "no broker available"),
 * which makes the companion fall through to the direct-CLI path
 * without paying the previous ~2s spawn-and-time-out tax (H1 fix).
 *
 * The full file is preserved in git history at commit 27dd18e~1.
 * Eventual deletion: when the legacy gemini-companion path is fully
 * migrated to the facade route.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PID_FILE_ENV = "GEMINI_COMPANION_ACP_PID_FILE";
export const LOG_FILE_ENV = "GEMINI_COMPANION_ACP_LOG_FILE";
export const STALE_BROKER_AGE_MS = 60 * 60 * 1000;

const SESSION_FILENAME = "broker-session.json";

function sessionPathFor(cwd) {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  const root = xdg ? xdg : path.join(os.homedir(), ".local", "state");
  const safeCwd = cwd.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(root, "artagon-agent-cli-plugin", "broker", `${safeCwd}-${SESSION_FILENAME}`);
}

/**
 * Stub: always returns null. Prior to H1 this read a JSON file from
 * disk; the file may still exist from before the broker was deleted,
 * but a non-null return would route callers into ensureBrokerSession
 * which always fails post-Step-5. Return null unconditionally so the
 * companion's direct-CLI fallback path is taken cleanly.
 *
 * @param {string} _cwd
 * @returns {any}
 */
export function loadBrokerSession(_cwd) {
  return null;
}

/**
 * Best-effort: delete the on-disk session file if it exists, so a
 * stale post-migration file doesn't trigger spurious logging on
 * future reads.
 *
 * @param {string} cwd
 */
export function clearBrokerSession(cwd) {
  try {
    fs.unlinkSync(sessionPathFor(cwd));
  } catch {
    // best-effort — file already gone, or permissions issue.
  }
}

/**
 * Stub: nothing to reap.
 * @param {string} _cwd
 * @param {(pid: number) => boolean} [_killProcess]
 * @returns {Promise<{ reaped: boolean, reason: string }>}
 */
export async function reapStaleBroker(_cwd, _killProcess) {
  return { reaped: false, reason: "broker deleted in Step 5" };
}

/**
 * Stub: broker daemon was deleted; always returns null so the
 * companion's direct-CLI path runs.
 *
 * @param {string} _cwd
 * @param {object} [_options]
 * @returns {Promise<any>}
 */
export async function ensureBrokerSession(_cwd, _options = {}) {
  return null;
}

/**
 * Stub: nothing to teardown.
 *
 * @param {object} [_options]
 */
export function teardownBrokerSession(_options = {}) {
  // no-op
}

/**
 * Stub: broker daemon doesn't exist anymore.
 *
 * @param {string} _endpoint
 * @returns {Promise<void>}
 */
export async function sendBrokerShutdown(_endpoint) {
  // no-op
}
