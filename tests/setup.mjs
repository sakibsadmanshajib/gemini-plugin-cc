/**
 * Vitest global setup. Catches env-leakage across tests so the Phase 4
 * "lib reads context, env is read at boundary only" contract isn't
 * silently subverted by a test that forgets to clean up after itself.
 *
 * Behaviour:
 *
 *   beforeEach    snapshot the set of `ARTAGON_*` + `ACP_WIRE_LOG*`
 *                 keys currently in `process.env`
 *   afterEach     diff against the snapshot — if a test ADDED any
 *                 internal-config keys, fail loudly with the offender
 *                 listed
 *
 * Pre-existing keys in the host environment are NOT flagged — only
 * NEW keys introduced during a test are. This means developers running
 * the suite with `ARTAGON_*` already set in their shell don't get
 * spurious failures.
 *
 * Why a setup file (not a custom matcher): the leakage check must run
 * AFTER every test regardless of pass/fail, and the message must
 * point at the test that caused the leak. Vitest's `setupFiles`
 * registers global `beforeEach`/`afterEach` hooks that run for every
 * test in the suite.
 */

import { afterEach, beforeEach, expect } from "vitest";

/** Keys that are NOT internal config and should be ignored. */
const IGNORED_PREFIXES = [
  "ACP_PLUGIN_VERSION", // legacy feature-flag name that pre-dates the refactor
  "ACP_REPLAY_FIXTURE", // test-orchestration env
  "ACP_BROKER_", // broker-test-orchestration env
  "ACP_FORCE_" // broker-test-orchestration env
];

function isInternalConfigKey(key) {
  if (key.startsWith("ARTAGON_")) {
    // ARTAGON_REAL_CLI_SMOKE is a test-orchestration env, not internal config.
    if (key === "ARTAGON_REAL_CLI_SMOKE") return false;
    return true;
  }
  if (key.startsWith("ACP_WIRE_LOG")) return true;
  if (IGNORED_PREFIXES.some((p) => key.startsWith(p))) return false;
  return false;
}

/** @type {Set<string>} */
let snapshot = new Set();

beforeEach(() => {
  snapshot = new Set(Object.keys(process.env).filter(isInternalConfigKey));
});

afterEach(() => {
  const after = Object.keys(process.env).filter(isInternalConfigKey);
  const leaked = after.filter((k) => !snapshot.has(k));
  if (leaked.length === 0) return;

  // Clean up before throwing so subsequent tests aren't impacted.
  for (const key of leaked) {
    Reflect.deleteProperty(process.env, key);
  }
  // Throw the failure inside an `expect` so vitest attributes it to
  // the test that leaked.
  expect(leaked).toEqual(
    // Diagnostic message: this assertion will fail with the leaked-key
    // list visible.
    /** @type {string[]} */ ([])
  );
});
