/**
 * Property tests for `lib/middleware/redaction.mjs` field-level redaction.
 *
 * The existing property test in tests/unit/middleware.test.mjs only
 * covers pattern-based redaction (sk-/ant-/AIza prefixes). The middleware
 * also supports field-level redaction via the `fieldNames` set — that's
 * the path the runtime takes for credentials carried as named JSON-RPC
 * params (`api_key`, `token`, etc.). Adds property coverage for the
 * field-level path:
 *
 *   1. For any (fieldName, secretValue) where fieldName ∈ fieldNames:
 *      the value at that field MUST be the replacement sentinel after
 *      redaction. The original value MUST NOT appear at that field.
 *   2. Non-credential fields pass through unchanged.
 *   3. Redaction recurses into nested objects + arrays.
 */

import fc from "fast-check";
import { expect, test } from "vitest";

import { redactValue } from "#lib/middleware/redaction.mjs";

const SENSITIVE_FIELD_NAMES = [
  "api_key",
  "apiKey",
  "authorization",
  "Authorization",
  "password",
  "token",
  "access_token",
  "refresh_token",
  "secret"
];

const config = {
  patterns: [],
  fieldNames: new Set(SENSITIVE_FIELD_NAMES),
  replacement: "[redacted]"
};

test("property: top-level credential field always redacts to the sentinel", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...SENSITIVE_FIELD_NAMES),
      // Any non-empty string. The middleware redacts when the field
      // is in fieldNames AND the value is a non-empty string (per
      // the implementation at lib/middleware/redaction.mjs:100).
      fc.string({ minLength: 1, maxLength: 200 }),
      (fieldName, secretValue) => {
        const input = { [fieldName]: secretValue, kept: "value-stays" };
        const out = /** @type {Record<string, unknown>} */ (redactValue(input, config));
        expect(out[fieldName]).toBe("[redacted]");
        expect(out.kept).toBe("value-stays");
      }
    ),
    { numRuns: 100 }
  );
});

test("property: empty-string credential field is preserved (the implementation skips empty)", () => {
  // Per the middleware implementation, only NON-EMPTY string values
  // get the sentinel. An empty string passes through. This is an
  // explicit choice — empty strings aren't "credentials" worth
  // redacting and clobbering them to "[redacted]" would lose
  // structural information. Lock that contract here.
  fc.assert(
    fc.property(fc.constantFrom(...SENSITIVE_FIELD_NAMES), (fieldName) => {
      const input = { [fieldName]: "" };
      const out = /** @type {Record<string, unknown>} */ (redactValue(input, config));
      expect(out[fieldName]).toBe("");
    }),
    { numRuns: 30 }
  );
});

test("property: nested credential fields redact at any depth", () => {
  // Field-name redaction recurses through arrays and nested objects
  // — pino's `*.<name>` only goes one level, but redactValue is
  // structural. Verify with arbitrarily-nested inputs.
  // minLength: 8 on the secret avoids false-positive substring
  // matches against the field name itself (e.g. "c" is a substring
  // of "[redacted]"). Realistic credential lengths anyway. The
  // load-bearing assertion is structural (walk + check value);
  // substring is defense-in-depth.
  fc.assert(
    fc.property(
      fc.constantFrom(...SENSITIVE_FIELD_NAMES),
      fc.string({ minLength: 8, maxLength: 50 }),
      fc.integer({ min: 1, max: 5 }), // nesting depth
      (fieldName, secretValue, depth) => {
        // Build {wrap: {wrap: {wrap: {<fieldName>: secret}}}} of N levels.
        /** @type {Record<string, unknown>} */
        let inner = { [fieldName]: secretValue };
        for (let i = 0; i < depth; i++) {
          inner = { wrap: inner };
        }
        // Structural walk to the deepest field — robust to
        // substring noise.
        /** @type {any} */
        let cursor = redactValue(inner, config);
        for (let i = 0; i < depth; i++) {
          cursor = cursor.wrap;
        }
        expect(cursor[fieldName]).toBe("[redacted]");
        // Defense-in-depth: the original secret value must not
        // survive anywhere in the serialized output.
        const json = JSON.stringify(redactValue(inner, config));
        expect(json).not.toContain(secretValue);
      }
    ),
    { numRuns: 100 }
  );
});

test("property: array of objects each get their credential fields redacted", () => {
  // The redactor walks arrays — so a request param like
  // `messages: [{api_key: "..."}, {api_key: "..."}]` must redact
  // every entry, not just the first.
  fc.assert(
    fc.property(
      fc.array(fc.string({ minLength: 1, maxLength: 30 }), {
        minLength: 1,
        maxLength: 5
      }),
      (secrets) => {
        const items = secrets.map((s) => ({ api_key: s, ok: "kept" }));
        const out = /** @type {Array<Record<string, unknown>>} */ (redactValue(items, config));
        for (let i = 0; i < items.length; i++) {
          expect(out[i].api_key).toBe("[redacted]");
          expect(out[i].ok).toBe("kept");
        }
      }
    ),
    { numRuns: 50 }
  );
});

test("property: non-credential field names pass through unchanged", () => {
  // Picks a field name that's NOT in fieldNames. Whatever string
  // value it holds must come back identically.
  //
  // Filter list:
  //   - SENSITIVE_FIELD_NAMES — these intentionally redact
  //   - __proto__ / constructor / prototype — JS-special names that
  //     set the prototype chain rather than own-properties when
  //     used in `{ [name]: value }` object literals. fast-check
  //     found `__proto__` as a counterexample on Node 20: setting
  //     `{ ["__proto__"]: "" }` doesn't create an own-property at
  //     all, so reading `out.__proto__` returns the actual prototype
  //     object, not the value. This is a prototype-pollution-class
  //     edge case the test isn't trying to exercise; fixed by
  //     excluding the special names.
  const PROTO_SPECIAL = ["__proto__", "constructor", "prototype"];
  fc.assert(
    fc.property(
      fc
        .string({ minLength: 1, maxLength: 20 })
        .filter((name) => !SENSITIVE_FIELD_NAMES.includes(name) && !PROTO_SPECIAL.includes(name)),
      fc.string({ minLength: 0, maxLength: 100 }),
      (fieldName, fieldValue) => {
        const input = { [fieldName]: fieldValue };
        const out = /** @type {Record<string, unknown>} */ (redactValue(input, config));
        expect(out[fieldName]).toBe(fieldValue);
      }
    ),
    { numRuns: 100 }
  );
});
