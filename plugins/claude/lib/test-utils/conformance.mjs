/**
 * AcpSession conformance suite.
 *
 * Every transport (CliTransport, future SdkTransport, future HttpTransport)
 * and every backend (MockBackend, geminiBackend, future codexBackend) MUST
 * pass this suite. The suite is the executable definition of the AcpSession
 * contract — types in `lib/acp/types.mjs` pin the shape, this suite pins
 * the behavior.
 *
 * Usage from a vitest spec:
 *
 *   import { runConformanceSuite } from "../../lib/test-utils/conformance.mjs";
 *   import { createMockBackend } from "../../lib/test-utils/mock-backend.mjs";
 *
 *   runConformanceSuite("MockBackend", () => createMockBackend());
 *
 * The factory is invoked once per test so each scenario gets a fresh
 * implementation. Implementations that need warm-up (e.g., subprocess
 * spawn) are awaited via `start()` inside each scenario.
 */

import { describe, expect, test } from "vitest";

import { createAcpClient } from "../acp/client.mjs";

/**
 * @typedef {import("../acp/client.mjs").ClientTransport} ClientTransport
 *
 * @typedef {ClientTransport & {
 *   onRequest?(method: string, handler: (params: any) => any | Promise<any>): void,
 *   pushNotification?(method: string, params?: object): void
 * }} ConformableTransport
 */

/**
 * Run the AcpSession conformance suite against the given factory.
 *
 * @param {string} name - Display name (e.g., "MockBackend", "CliTransport").
 * @param {() => ConformableTransport} factory - Returns a fresh transport per test.
 */
export function runConformanceSuite(name, factory) {
  describe(`AcpSession conformance: ${name}`, () => {
    test("starts and reports active health", async () => {
      const transport = factory();
      const client = createAcpClient(transport);
      await client.start();
      expect(client.isOpen()).toBe(true);
      expect(["active", "queued"]).toContain(client.healthState());
      await client.close();
    });

    test("close is idempotent", async () => {
      const transport = factory();
      const client = createAcpClient(transport);
      await client.start();
      await client.close();
      await client.close();
      expect(client.isOpen()).toBe(false);
    });

    test("request → response round-trips", async () => {
      const transport = factory();
      // Only mock-style transports support `onRequest`. CliTransport drives a
      // real subprocess and gets canned answers from the mock binary.
      if (typeof transport.onRequest === "function") {
        transport.onRequest("ping", () => ({ pong: true }));
      }
      const client = createAcpClient(transport);
      await client.start();
      const result = await client.request("ping", {});
      expect(result).toEqual({ pong: true });
      await client.close();
    });

    test("request to unknown method rejects with error", async () => {
      const transport = factory();
      const client = createAcpClient(transport);
      await client.start();
      await expect(client.request("definitely.not.a.method", {})).rejects.toThrow(
        /method not found/i
      );
      await client.close();
    });

    test("notification handler fires on inbound notification", async () => {
      const transport = factory();
      const client = createAcpClient(transport);
      await client.start();

      /** @type {any[]} */
      const captured = [];
      const unsubscribe = client.onNotification((n) => captured.push(n));

      if (typeof transport.pushNotification === "function") {
        transport.pushNotification("session/update", {
          sessionId: "s1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { text: "hi" }
          }
        });
        // Allow microtask drain.
        await new Promise((r) => setTimeout(r, 5));
      }

      // For mock-style transports, captured must contain the pushed notification.
      // CliTransport against gemini-mock won't emit unprompted notifications
      // here, so this assertion only fires when pushNotification is supported.
      if (typeof transport.pushNotification === "function") {
        expect(captured).toHaveLength(1);
        expect(captured[0].method).toBe("session/update");
      }

      unsubscribe();
      await client.close();
    });

    test("health-change handler observes transitions", async () => {
      const transport = factory();
      const client = createAcpClient(transport);
      /** @type {string[]} */
      const observed = [];
      client.onHealthChange((s) => observed.push(s));
      await client.start();
      await client.close();
      // We expect at least one transition (start → active OR close → completed/cancelled).
      expect(observed.length).toBeGreaterThan(0);
    });

    test("request on closed transport rejects", async () => {
      const transport = factory();
      const client = createAcpClient(transport);
      await client.start();
      await client.close();
      await expect(client.request("ping", {})).rejects.toThrow(/closed/i);
    });

    test("notify on closed transport throws", async () => {
      const transport = factory();
      const client = createAcpClient(transport);
      await client.start();
      await client.close();
      expect(() => client.notify("session/cancel", { sessionId: "s1" })).toThrow(/closed/i);
    });
  });
}
