/**
 * Cross-layer redaction invariant test.
 *
 * The project ships THREE independent redaction layers, each with its
 * own credential field-name source:
 *
 *   1. `lib/middleware/redaction.mjs` DEFAULT_FIELD_NAMES  (PRIMARY)
 *   2. `lib/wire-log.mjs` REDACT_TOKENS                    (defense-in-depth)
 *   3. `lib/logger.mjs` REDACTED_PATHS                     (defense-in-depth)
 *
 * Each list has a different SHAPE because each layer uses a different
 * mechanism (Set of strings, array of regex, pino path syntax). But
 * the underlying field NAMES they protect must agree — a name in one
 * but not in another opens a leak window for payloads that bypass that
 * layer. The comments at the top of each file already remind
 * maintainers of this; this test makes the invariant enforceable.
 *
 * The test extracts each list's name-set and asserts equivalence.
 *
 * Why this matters: the wire-log password-redaction bug fixed in
 * 0de73ac (regex missing capture group → field name mangled to a
 * number) AND the logger top-level credential leak fixed in b3e239a
 * (pino `*.<name>` doesn't match top-level fields) both went
 * undetected for a while because no test compared the lists
 * structurally. Locking the invariant here means future divergence
 * fails CI immediately rather than silently shipping a leak window.
 */

import { expect, test } from "vitest";

import { REDACTED_PATHS } from "#lib/logger.mjs";
import { DEFAULT_FIELD_NAMES } from "#lib/middleware/redaction.mjs";
import { REDACT_TOKENS } from "#lib/wire-log.mjs";

/**
 * Extract the credential field names from each layer:
 *   - redaction.mjs: array of strings, use as-is
 *   - logger.mjs: pino path syntax — bare names are top-level paths,
 *     `*.<name>` are one-level-nested. We're interested in the bare set.
 *     Filter out the `params.*` and `credentials.*` JSON-RPC-shape paths
 *     since those aren't field-name-equivalent (they're path patterns).
 *   - wire-log.mjs: regex source, extract group 1 alternation tokens
 *     from each pattern.
 */
function namesFromRedaction() {
  return new Set(DEFAULT_FIELD_NAMES);
}

function namesFromLogger() {
  // Keep only entries with no `*.` prefix and no `.` separator (i.e.
  // bare top-level field names). Excludes `*.api_key`, `params.api_key`,
  // `credentials.*`. The bare entries are the canonical name list per
  // the bare-vs-wildcard fix in b3e239a.
  return new Set(REDACTED_PATHS.filter((p) => !p.startsWith("*.") && !p.includes(".")));
}

function namesFromWireLog() {
  // Each REDACT_TOKEN regex source is `"(<name>|<name>|...)"\s*:\s*"[^"]*"`.
  // Extract the alternation list inside the first capture group.
  /** @type {Set<string>} */
  const out = new Set();
  for (const re of REDACT_TOKENS) {
    const match = re.source.match(/^"\(([^)]+)\)"/);
    if (!match) {
      throw new Error(`wire-log REDACT_TOKEN regex doesn't have group 1 capture: ${re.source}`);
    }
    for (const name of match[1].split("|")) {
      out.add(name);
    }
  }
  return out;
}

test("cross-layer: redaction / wire-log / logger all share the same credential field-name set", () => {
  const redactionNames = namesFromRedaction();
  const loggerNames = namesFromLogger();
  const wireLogNames = namesFromWireLog();

  // Sorted-array comparison gives a clear diff when sets diverge.
  const sortedArr = (s) => [...s].sort();
  expect(sortedArr(loggerNames)).toEqual(sortedArr(redactionNames));
  expect(sortedArr(wireLogNames)).toEqual(sortedArr(redactionNames));
});

test("cross-layer: every credential name appears in all three lists", () => {
  // Defensive — same invariant as above but with per-name diagnostics
  // so a regression points at the missing layer immediately.
  const redactionNames = namesFromRedaction();
  const loggerNames = namesFromLogger();
  const wireLogNames = namesFromWireLog();

  for (const name of redactionNames) {
    expect(loggerNames.has(name), `logger.mjs REDACTED_PATHS missing bare "${name}"`).toBe(true);
    expect(wireLogNames.has(name), `wire-log.mjs REDACT_TOKENS missing "${name}"`).toBe(true);
  }
});
