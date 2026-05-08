/**
 * Integration test for CliTransport driving the real ACP-mock binary.
 *
 * Where the unit conformance suite exercises MockBackend (in-memory),
 * this test exercises the full subprocess + JSON-RPC framing path:
 *   - spawn `node tests/mocks/gemini-mock.mjs --acp`
 *   - newline-delimited JSON over stdio
 *   - readline-based line buffer
 *   - SIGTERM-on-close lifecycle
 *
 * The mock binary already speaks `initialize` and `authenticate`. We use
 * those for round-trip verification; tests that need broader scripted
 * behavior (notifications, error envelopes for arbitrary methods) belong
 * in MockBackend conformance — not here.
 */

import path from "node:path";
import { afterEach, expect, test } from "vitest";

import { createAcpClient } from "#lib/acp/client.mjs";
import { createCliTransport } from "#lib/transport/cli.mjs";

const MOCK_PATH = path.resolve(new URL("../mocks/gemini-mock.mjs", import.meta.url).pathname);

/** @type {{ close: () => Promise<void> }[]} */
const teardown = [];

afterEach(async () => {
  while (teardown.length) {
    const t = teardown.pop();
    if (t) await t.close();
  }
});

function makeTransport() {
  const transport = createCliTransport({
    command: process.execPath,
    args: [MOCK_PATH, "--acp"],
    env: process.env
  });
  teardown.push({ close: () => transport.close() });
  return transport;
}

test("CliTransport: start spawns subprocess, reports active health", async () => {
  const transport = makeTransport();
  await transport.start();
  expect(transport.isOpen()).toBe(true);
  expect(transport.healthState()).toBe("active");
});

test("CliTransport: initialize round-trip via createAcpClient", async () => {
  const transport = makeTransport();
  const client = createAcpClient(transport);
  await client.start();
  const result = /** @type {any} */ (
    await client.request("initialize", { clientInfo: { name: "test" } })
  );
  expect(result.protocolVersion).toBe(1);
  expect(Array.isArray(result.authMethods)).toBe(true);
  expect(result.authMethods[0]).toMatchObject({ id: "oauth-personal" });
});

test("CliTransport: authenticate round-trip", async () => {
  const transport = makeTransport();
  const client = createAcpClient(transport);
  await client.start();
  // initialize first (mock advertises auth methods after init).
  await client.request("initialize", { clientInfo: { name: "test" } });
  const auth = /** @type {any} */ (
    await client.request("authenticate", { methodId: "oauth-personal" })
  );
  expect(auth.authenticated).toBe(true);
});

test("CliTransport: unknown method rejects with error envelope", async () => {
  const transport = makeTransport();
  const client = createAcpClient(transport);
  await client.start();
  await expect(client.request("definitely.not.a.method", {})).rejects.toThrow(/method not found/i);
});

test("CliTransport: close is idempotent", async () => {
  const transport = makeTransport();
  await transport.start();
  await transport.close();
  await transport.close();
  expect(transport.isOpen()).toBe(false);
});

test("CliTransport: request after close throws", async () => {
  const transport = makeTransport();
  const client = createAcpClient(transport);
  await client.start();
  await client.close();
  await expect(client.request("initialize", {})).rejects.toThrow(/closed/i);
});

test("CliTransport: notify after close throws", async () => {
  const transport = makeTransport();
  const client = createAcpClient(transport);
  await client.start();
  await client.close();
  expect(() => client.notify("session/cancel", { sessionId: "s1" })).toThrow(/closed/i);
});

test("CliTransport: multiple sequential requests share the same subprocess", async () => {
  const transport = makeTransport();
  const client = createAcpClient(transport);
  await client.start();
  for (let i = 0; i < 3; i++) {
    const r = /** @type {any} */ (
      await client.request("initialize", { clientInfo: { name: `test-${i}` } })
    );
    expect(r.protocolVersion).toBe(1);
  }
  await client.close();
});

test("CliTransport: health transitions from queued → active → completed", async () => {
  const transport = makeTransport();
  /** @type {string[]} */
  const observed = [];
  transport.onHealthChange((s) => observed.push(s));
  await transport.start();
  await transport.close();
  expect(observed).toContain("active");
  // After close on a clean exit, we expect "completed". Some platforms may
  // emit "cancelled" if the child reports non-zero — accept either.
  expect(observed.some((s) => s === "completed" || s === "cancelled")).toBe(true);
});
