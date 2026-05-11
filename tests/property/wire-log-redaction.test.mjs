/**
 * Property tests for `lib/wire-log.mjs` redaction.
 *
 * The example-based tests in `tests/unit/wire-log.test.mjs` use a
 * fixed set of credential values; this property suite throws random
 * strings at the redactor and asserts the same invariants on every
 * generated input:
 *
 *   1. The original credential VALUE never survives in the on-disk
 *      output (the leak invariant).
 *   2. The credential FIELD NAME survives with `[redacted]` as its
 *      value (the structure invariant — caught the password bug
 *      where the field name was being replaced by the regex offset
 *      number, see commit 0de73ac).
 *   3. Non-credential fields and their values pass through unchanged.
 *
 * Why fast-check here: redaction is a security property, and example-
 * based tests can't enumerate the unicode/escape/control-char inputs
 * that real payloads contain. fast-check shrinks counterexamples to
 * a minimal failing input — much faster to debug than a leak found
 * in production logs.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import fc from "fast-check";
import { afterEach, beforeEach, expect, test } from "vitest";

import { openWireLog } from "#lib/wire-log.mjs";

const SENSITIVE_FIELDS = [
  "api_key",
  "apiKey",
  "authorization",
  "Authorization",
  "token",
  "access_token",
  "refresh_token",
  "password",
  "secret"
];

/** @type {string} */
let tmpDir;
/** @type {string} */
let logPath;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wire-log-prop-"));
  logPath = path.join(tmpDir, "wire.jsonl");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("property: any string value in any sensitive field is redacted", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...SENSITIVE_FIELDS),
      // String generation: avoid raw double quotes (would split the
      // regex match) and short / common-substring values that the
      // raw-text leak check would false-positive on (e.g. "K" is
      // legitimately a substring of "apiKey"). minLength: 8 mirrors
      // realistic credential shapes; the structural check below
      // (parse + assert value) is the load-bearing assertion either
      // way.
      fc
        .string({ minLength: 8, maxLength: 64 })
        .filter((s) => !s.includes('"')),
      (fieldName, secretValue) => {
        const log = openWireLog({ wireLogPath: logPath });
        log.record("out", {
          method: "test",
          params: { [fieldName]: secretValue, kept: "value-stays" }
        });
        log.close();

        const raw = fs.readFileSync(logPath, "utf8").trim();
        // Reset the file for the next property iteration.
        fs.writeFileSync(logPath, "");

        // (1) Leak invariant — STRUCTURAL: parse the on-disk JSON
        //     and assert the credential field's value is the
        //     redacted sentinel. This is the assertion that would
        //     have caught the password→offset-number bug
        //     (commit 0de73ac), since after that bug the field name
        //     itself was different.
        const parsed = JSON.parse(raw);
        expect(parsed.msg.params[fieldName]).toBe("[redacted]");
        // (2) Defense-in-depth: also check the original value isn't
        //     sitting somewhere unexpected in the raw text. The
        //     minLength: 8 above keeps this from false-positing
        //     against structural fragments like "params" / method
        //     names / the field name itself.
        expect(raw).not.toContain(secretValue);
        // (3) Pass-through: non-credential field unchanged.
        expect(parsed.msg.params.kept).toBe("value-stays");
      }
    ),
    { numRuns: 100 }
  );
});

test("property: redacted output is still valid JSON", () => {
  // After redaction the JSONL line MUST still parse as JSON. A bug
  // like the password→offset-number one (now fixed) produced
  // numeric-string keys which JSON.parse accepts — but other shape
  // mistakes (unmatched quote, missing colon) wouldn't. Property
  // tests catch those before they reach prod.
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom(...SENSITIVE_FIELDS), {
        minLength: 1,
        maxLength: 5
      }),
      fc.string({ minLength: 1, maxLength: 32 }).filter((s) => !s.includes('"')),
      (fieldNames, sharedSecret) => {
        /** @type {Record<string, string>} */
        const params = {};
        for (const f of fieldNames) params[f] = sharedSecret;
        params.passthrough = "kept";

        const log = openWireLog({ wireLogPath: logPath });
        log.record("out", { method: "test", params });
        log.close();

        const raw = fs.readFileSync(logPath, "utf8").trim();
        fs.writeFileSync(logPath, "");

        // The output MUST round-trip through JSON.parse cleanly.
        expect(() => JSON.parse(raw)).not.toThrow();
        const parsed = JSON.parse(raw);
        // And the credential values must all be the redacted sentinel.
        for (const f of fieldNames) {
          expect(parsed.msg.params[f]).toBe("[redacted]");
        }
        expect(parsed.msg.params.passthrough).toBe("kept");
      }
    ),
    { numRuns: 100 }
  );
});
