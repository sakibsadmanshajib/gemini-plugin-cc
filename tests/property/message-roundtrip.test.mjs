/**
 * Property tests for ACP message serialize → deserialize round-trip.
 *
 * The runtime sends JSON-RPC requests via `client.request(method, params)` and
 * receives notifications via `client.notify(method, params)`. The wire format
 * is JSON. These tests verify that any structurally-valid ACP request or
 * notification survives a JSON.stringify → JSON.parse cycle without loss.
 */

import fc from "fast-check";
import { expect, test } from "vitest";

/**
 * Compare two values via JSON-string equality. Avoids `Object.is`-based
 * distinctions vitest's `.toEqual` makes (notably `-0` vs `0`) that don't
 * survive a real wire — `JSON.stringify(-0)` is `"0"`. The wire round-trip
 * is the production-faithful comparison; structural equality after that is
 * sufficient.
 */
function expectJsonEqual(actual, expected) {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

const acpMethods = [
  "initialize",
  "authenticate",
  "session/new",
  "session/load",
  "session/set_mode",
  "session/set_model",
  "session/prompt",
  "session/cancel",
  "session/update",
  "broker/diagnostic"
];

test("property: ACP request shape round-trips through JSON", () => {
  const request = fc.record({
    jsonrpc: fc.constant("2.0"),
    id: fc.oneof(fc.integer({ min: 1, max: 100000 }), fc.uuid()),
    method: fc.constantFrom(...acpMethods),
    params: fc.dictionary(fc.string({ minLength: 1, maxLength: 30 }), fc.jsonValue())
  });
  fc.assert(
    fc.property(request, (msg) => {
      expectJsonEqual(JSON.parse(JSON.stringify(msg)), msg);
    }),
    { numRuns: 200 }
  );
});

test("property: ACP notification (no id) round-trips", () => {
  const notification = fc.record({
    jsonrpc: fc.constant("2.0"),
    method: fc.constantFrom(...acpMethods),
    params: fc.dictionary(fc.string({ minLength: 1, maxLength: 30 }), fc.jsonValue())
  });
  fc.assert(
    fc.property(notification, (msg) => {
      const wire = JSON.stringify(msg);
      // Notifications MUST NOT have an `id` field on the wire — server uses
      // its presence to distinguish requests from notifications.
      expect(wire.includes('"id"')).toBe(false);
      expectJsonEqual(JSON.parse(wire), msg);
    }),
    { numRuns: 100 }
  );
});

test("property: response with result shape round-trips", () => {
  const response = fc.record({
    jsonrpc: fc.constant("2.0"),
    id: fc.oneof(fc.integer({ min: 1, max: 100000 }), fc.uuid()),
    result: fc.jsonValue()
  });
  fc.assert(
    fc.property(response, (msg) => {
      expectJsonEqual(JSON.parse(JSON.stringify(msg)), msg);
    }),
    { numRuns: 100 }
  );
});

test("property: error envelope shape round-trips with code + message", () => {
  const errorEnvelope = fc.record({
    jsonrpc: fc.constant("2.0"),
    id: fc.oneof(fc.integer({ min: 1, max: 100000 }), fc.uuid()),
    error: fc.record({
      code: fc.integer({ min: -32999, max: -32000 }),
      message: fc.string({ maxLength: 200 }),
      data: fc.option(fc.jsonValue())
    })
  });
  fc.assert(
    fc.property(errorEnvelope, (msg) => {
      const parsed = JSON.parse(JSON.stringify(msg));
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.id).toEqual(msg.id);
      expect(parsed.error.code).toBe(msg.error.code);
      expect(parsed.error.message).toBe(msg.error.message);
    }),
    { numRuns: 100 }
  );
});

test("property: nested params with deep structures preserved", () => {
  // ACP `session/prompt` params have shape `{ sessionId, prompt: [{type, text}] }`.
  // Test that arbitrarily-nested prompt content fields survive the round-trip.
  const promptParams = fc.record({
    sessionId: fc.uuid(),
    prompt: fc.array(
      fc.record({
        type: fc.constantFrom("text", "image", "tool_result"),
        text: fc.string({ maxLength: 500 })
      }),
      { minLength: 1, maxLength: 10 }
    )
  });
  fc.assert(
    fc.property(promptParams, (params) => {
      expectJsonEqual(JSON.parse(JSON.stringify(params)), params);
    }),
    { numRuns: 100 }
  );
});
