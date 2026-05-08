/**
 * Property tests for JSON-RPC line framing.
 *
 * The runtime parses ACP frames as newline-delimited JSON via `readline`.
 * These tests fuzz the line-splitting + JSON-parse contract to catch
 * partial-buffer, malformed-frame, and unicode edge cases that example-based
 * tests miss.
 *
 * The framing layer used by the runtime is `readline.createInterface({ input })`
 * over a Readable. Each emitted line is JSON-parsed by call sites in
 * `acp-broker.mjs::handleAcpLine` and `acp-client.mjs`. We test the contract
 * those call sites assume: any input the parser accepts MUST round-trip;
 * malformed input MUST be silently dropped (not throw).
 */

import fc from "fast-check";
import { expect, test } from "vitest";

/**
 * Pure framing helper mirroring how the runtime ingests JSON-RPC lines.
 * Splits on `\n`, ignores empty lines, returns parsed objects (or skips
 * unparseable ones — matches `acp-broker.mjs:166-171` and
 * `acp-client.mjs::handleLine`).
 */
function parseFrames(buffer) {
  const out = [];
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Match runtime behavior: silently drop unparseable frames.
    }
  }
  return out;
}

test("property: JSON serialize → newline-frame → parseFrames round-trips", () => {
  const jsonRpcMessage = fc.record({
    jsonrpc: fc.constant("2.0"),
    id: fc.oneof(fc.integer({ min: 1, max: 1000 }), fc.string()),
    method: fc.string({ minLength: 1, maxLength: 50 }),
    params: fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue())
  });
  fc.assert(
    fc.property(fc.array(jsonRpcMessage, { maxLength: 20 }), (messages) => {
      const buffer = messages.map((m) => JSON.stringify(m)).join("\n");
      const parsed = parseFrames(buffer);
      // JSON-string equality avoids `Object.is(-0, 0) === false` flakes that
      // vitest's `.toEqual` would surface; `JSON.stringify(-0)` is "0", so the
      // wire-level normalization is the production-faithful comparison.
      expect(JSON.stringify(parsed)).toBe(JSON.stringify(messages));
    }),
    { numRuns: 100 }
  );
});

test("property: empty lines are silently ignored", () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom("", "  ", "\t", "\n"), { maxLength: 50 }), (lines) => {
      const buffer = lines.join("\n");
      expect(parseFrames(buffer)).toEqual([]);
    }),
    { numRuns: 50 }
  );
});

test("property: malformed frames are dropped, not thrown", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 30 }), (lines) => {
      // parseFrames must never throw, regardless of input content.
      expect(() => parseFrames(lines.join("\n"))).not.toThrow();
    }),
    { numRuns: 100 }
  );
});

test("property: valid + malformed mixed — only valid survive", () => {
  const valid = fc.record({
    jsonrpc: fc.constant("2.0"),
    method: fc.string({ minLength: 1, maxLength: 30 })
  });
  const malformed = fc.oneof(
    fc.constantFrom("not json", "{", "}", "[", "{ bad: }", '{"unterminated"'),
    fc.string().filter((s) => {
      try {
        JSON.parse(s);
        return false;
      } catch {
        return true;
      }
    })
  );
  fc.assert(
    fc.property(
      fc.array(valid, { minLength: 1, maxLength: 10 }),
      fc.array(malformed, { maxLength: 10 }),
      (validMsgs, badMsgs) => {
        // Interleave valid + malformed.
        const lines = [];
        const max = Math.max(validMsgs.length, badMsgs.length);
        for (let i = 0; i < max; i++) {
          if (i < validMsgs.length) lines.push(JSON.stringify(validMsgs[i]));
          if (i < badMsgs.length) lines.push(badMsgs[i]);
        }
        const parsed = parseFrames(lines.join("\n"));
        // Every valid message must appear in the parsed output (order-preserved).
        expect(parsed.length).toBe(validMsgs.length);
        for (let i = 0; i < validMsgs.length; i++) {
          expect(parsed[i]).toEqual(validMsgs[i]);
        }
      }
    ),
    { numRuns: 100 }
  );
});

test("property: unicode strings in JSON survive framing", () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      const message = { jsonrpc: "2.0", method: "test", params: { text } };
      const buffer = JSON.stringify(message);
      // Forbidden: a buffer with embedded literal newline would break the
      // newline-framed wire. JSON.stringify escapes `\n` to `\\n`, so this
      // must be invariant.
      expect(buffer.includes("\n")).toBe(false);
      const parsed = parseFrames(buffer);
      expect(parsed).toEqual([message]);
    }),
    { numRuns: 100 }
  );
});
