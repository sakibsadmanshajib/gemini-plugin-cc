/**
 * Unit tests for the ACP test harness primitives.
 *
 * Three units are exercised here: paired transport, fake ACP backend, and
 * the JSONL fixture replayer. Each gets a small focused suite — these are
 * the building blocks for higher-level integration tests, so the harness
 * itself MUST be trustworthy.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";

import { createFakeAcpBackend } from "#lib/test-utils/fake-acp-backend.mjs";
import { parseFixture, replayFixture } from "#lib/test-utils/fixture-replayer.mjs";
import { createPairedTransport } from "#lib/test-utils/in-memory-transport.mjs";

// ─── createPairedTransport ────────────────────────────────────────────────────

test("paired transport: write on client emits line on server", async () => {
  const { client, server } = createPairedTransport();
  const received = [];
  server.on("line", (msg) => received.push(msg));
  client.write({ jsonrpc: "2.0", method: "ping", params: { x: 1 } });
  await new Promise((r) => queueMicrotask(r));
  await new Promise((r) => queueMicrotask(r));
  expect(received).toEqual([{ jsonrpc: "2.0", method: "ping", params: { x: 1 } }]);
});

test("paired transport: bidirectional write", async () => {
  const { client, server } = createPairedTransport();
  const clientLog = [];
  const serverLog = [];
  client.on("line", (m) => clientLog.push(m));
  server.on("line", (m) => serverLog.push(m));
  client.write({ jsonrpc: "2.0", method: "c→s" });
  server.write({ jsonrpc: "2.0", method: "s→c" });
  await new Promise((r) => queueMicrotask(r));
  await new Promise((r) => queueMicrotask(r));
  expect(serverLog).toEqual([{ jsonrpc: "2.0", method: "c→s" }]);
  expect(clientLog).toEqual([{ jsonrpc: "2.0", method: "s→c" }]);
});

test("paired transport: write after close throws", () => {
  const { client } = createPairedTransport();
  client.close();
  expect(() => client.write({ jsonrpc: "2.0", method: "ping" })).toThrow(/closed/i);
});

test("paired transport: closing one half closes the peer", async () => {
  const { client, server } = createPairedTransport();
  let serverClosed = false;
  server.on("close", () => {
    serverClosed = true;
  });
  client.close();
  await new Promise((r) => queueMicrotask(r));
  expect(serverClosed).toBe(true);
});

test("paired transport: round-trips through JSON (catches non-serializable)", () => {
  const { client } = createPairedTransport();
  // Functions are not JSON-serializable; the transport's stringify call drops them.
  // Verify the transport doesn't throw on this — it's deliberately permissive,
  // matching the runtime which accepts whatever JSON.stringify produces.
  expect(() =>
    client.write({ jsonrpc: "2.0", method: "ping", params: { f: () => {} } })
  ).not.toThrow();
});

// ─── createFakeAcpBackend ─────────────────────────────────────────────────────

test("fake backend: registered request handler returns result", async () => {
  const { client, server } = createPairedTransport();
  const backend = createFakeAcpBackend(server);
  backend.onRequest("ping", () => ({ pong: true }));
  const responses = [];
  client.on("line", (m) => responses.push(m));
  client.write({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
  await new Promise((r) => setTimeout(r, 10));
  expect(responses).toEqual([{ jsonrpc: "2.0", id: 1, result: { pong: true } }]);
});

test("fake backend: unhandled method returns -32601 error", async () => {
  const { client, server } = createPairedTransport();
  createFakeAcpBackend(server);
  const responses = [];
  client.on("line", (m) => responses.push(m));
  client.write({ jsonrpc: "2.0", id: 7, method: "unknown.method", params: {} });
  await new Promise((r) => setTimeout(r, 10));
  expect(responses).toHaveLength(1);
  expect(responses[0].id).toBe(7);
  expect(responses[0].error.code).toBe(-32601);
  expect(responses[0].error.message).toMatch(/unknown\.method/);
});

test("fake backend: notify pushes a notification (no id) to the client", async () => {
  const { client, server } = createPairedTransport();
  const backend = createFakeAcpBackend(server);
  const inbox = [];
  client.on("line", (m) => inbox.push(m));
  backend.notify("session/update", {
    sessionId: "s1",
    update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } }
  });
  await new Promise((r) => queueMicrotask(r));
  await new Promise((r) => queueMicrotask(r));
  expect(inbox).toHaveLength(1);
  expect(inbox[0].method).toBe("session/update");
  expect("id" in inbox[0]).toBe(false);
});

test("fake backend: inboundLog records every received request and notification", async () => {
  const { client, server } = createPairedTransport();
  const backend = createFakeAcpBackend(server);
  backend.onRequest("ping", () => ({}));
  client.write({ jsonrpc: "2.0", id: 1, method: "ping", params: {} });
  client.write({
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: "s1" }
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(backend.inboundLog).toHaveLength(2);
  expect(backend.inboundLog[0]).toMatchObject({ method: "ping", id: 1 });
  expect(backend.inboundLog[1]).toMatchObject({
    method: "session/cancel",
    id: null
  });
});

test("fake backend: handler that throws returns -32000 error", async () => {
  const { client, server } = createPairedTransport();
  const backend = createFakeAcpBackend(server);
  backend.onRequest("explode", () => {
    throw new Error("boom");
  });
  const responses = [];
  client.on("line", (m) => responses.push(m));
  client.write({ jsonrpc: "2.0", id: 9, method: "explode", params: {} });
  await new Promise((r) => setTimeout(r, 10));
  expect(responses[0].error.code).toBe(-32000);
  expect(responses[0].error.message).toBe("boom");
});

// ─── fixture replayer ─────────────────────────────────────────────────────────

function writeFixture(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acp-fixture-"));
  const file = path.join(dir, "fixture.jsonl");
  fs.writeFileSync(file, content, "utf8");
  return file;
}

test("parseFixture: ignores comments and blank lines", () => {
  const file = writeFixture(
    [
      "# this is a comment",
      "",
      `{"dir":"out","msg":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}}`,
      "  ",
      `{"dir":"in","msg":{"jsonrpc":"2.0","id":1,"result":{}}}`
    ].join("\n")
  );
  const records = parseFixture(file);
  expect(records).toHaveLength(2);
  expect(records[0].dir).toBe("out");
  expect(records[1].dir).toBe("in");
});

test("parseFixture: rejects malformed JSON with line number", () => {
  const file = writeFixture(`{"dir":"out","msg":{`);
  expect(() => parseFixture(file)).toThrow(/:1.*invalid JSON/i);
});

test("parseFixture: rejects unknown direction", () => {
  const file = writeFixture(`{"dir":"sideways","msg":{}}`);
  expect(() => parseFixture(file)).toThrow(/dir.*in.*out/i);
});

test("replayFixture: matched outbound + inbound sequence resolves", async () => {
  const file = writeFixture(
    [
      `{"dir":"out","msg":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"gemini"}}}}`,
      `{"dir":"in","msg":{"jsonrpc":"2.0","id":1,"result":{"capabilities":{}}}}`,
      `{"dir":"out","msg":{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp/x","mcpServers":[]}}}`,
      `{"dir":"in","msg":{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}}`
    ].join("\n")
  );
  const { client, server } = createPairedTransport();
  // Drive the client side by sending the outbound messages.
  const replay = replayFixture(file, server, { timeoutMs: 1000 });
  client.write({
    jsonrpc: "2.0",
    id: 99,
    method: "initialize",
    params: { clientInfo: { name: "gemini" } }
  });
  await new Promise((r) => setTimeout(r, 10));
  client.write({
    jsonrpc: "2.0",
    id: 100,
    method: "session/new",
    params: { cwd: "/tmp/x", mcpServers: [] }
  });
  const result = await replay;
  expect(result).toEqual({ matched: 2, total: 2 });
});

test("replayFixture: divergence rejects with diff message", async () => {
  const file = writeFixture(
    `{"dir":"out","msg":{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}}`
  );
  const { client, server } = createPairedTransport();
  const replay = replayFixture(file, server, { timeoutMs: 500 });
  client.write({ jsonrpc: "2.0", id: 1, method: "WRONG", params: {} });
  await expect(replay).rejects.toThrow(/divergence/i);
});
