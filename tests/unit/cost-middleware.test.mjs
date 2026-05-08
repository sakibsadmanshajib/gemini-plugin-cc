/**
 * Cost middleware unit tests.
 */

import { expect, test } from "vitest";

import { createAcpClient } from "#lib/acp/client.mjs";
import { createCostMiddleware, defaultExtractTokens } from "#lib/middleware/cost.mjs";
import { createMockBackend } from "#lib/test-utils/mock-backend.mjs";

test("defaultExtractTokens: Codex/Claude shape (usage.input_tokens / output_tokens)", () => {
  expect(
    defaultExtractTokens("session/prompt", {
      usage: { input_tokens: 100, output_tokens: 50 }
    })
  ).toEqual({ input: 100, output: 50, total: 150 });
});

test("defaultExtractTokens: Gemini shape (usageMetadata.promptTokenCount / candidatesTokenCount)", () => {
  expect(
    defaultExtractTokens("session/prompt", {
      usageMetadata: {
        promptTokenCount: 80,
        candidatesTokenCount: 40,
        totalTokenCount: 120
      }
    })
  ).toEqual({ input: 80, output: 40, total: 120 });
});

test("defaultExtractTokens: non-result shapes return null", () => {
  expect(defaultExtractTokens("session/prompt", { ok: true })).toBeNull();
  expect(defaultExtractTokens("initialize", null)).toBeNull();
  expect(defaultExtractTokens("session/cancel", "string")).toBeNull();
});

test("cost middleware: counts session/prompt requests", async () => {
  const backend = createMockBackend();
  backend.onRequest("session/prompt", () => ({ ok: true }));
  const cost = createCostMiddleware();
  const wrapped = cost.wrap(createAcpClient(backend));
  await wrapped.start();
  await wrapped.request("session/prompt", { prompt: "a" });
  await wrapped.request("session/prompt", { prompt: "b" });
  await wrapped.request("session/prompt", { prompt: "c" });
  expect(cost.record().counts.prompts).toBe(3);
  await wrapped.close();
});

test("cost middleware: does NOT count non-prompt requests as prompts", async () => {
  const backend = createMockBackend();
  backend.onRequest("initialize", () => ({ ok: true }));
  backend.onRequest("session/new", () => ({ sessionId: "s1" }));
  const cost = createCostMiddleware();
  const wrapped = cost.wrap(createAcpClient(backend));
  await wrapped.start();
  await wrapped.request("initialize", {});
  await wrapped.request("session/new", {});
  expect(cost.record().counts.prompts).toBe(0);
  await wrapped.close();
});

test("cost middleware: counts tool_call notifications", async () => {
  const backend = createMockBackend();
  const cost = createCostMiddleware();
  const wrapped = cost.wrap(createAcpClient(backend));
  await wrapped.start();
  /** @type {any[]} */
  const inbox = [];
  wrapped.onNotification((n) => inbox.push(n));
  backend.pushNotification("session/update", {
    sessionId: "s1",
    update: { sessionUpdate: "tool_call", toolName: "read_file" }
  });
  backend.pushNotification("session/update", {
    sessionId: "s1",
    update: { sessionUpdate: "agent_message_chunk", content: { text: "hi" } }
  });
  backend.pushNotification("session/update", {
    sessionId: "s1",
    update: { sessionUpdate: "tool_call", toolName: "edit_file" }
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(cost.record().counts.toolCalls).toBe(2);
  await wrapped.close();
});

test("cost middleware: counts errors", async () => {
  const backend = createMockBackend();
  backend.onRequest("session/prompt", () => {
    throw new Error("boom");
  });
  const cost = createCostMiddleware();
  const wrapped = cost.wrap(createAcpClient(backend));
  await wrapped.start();
  await expect(wrapped.request("session/prompt", {})).rejects.toThrow();
  await expect(wrapped.request("session/prompt", {})).rejects.toThrow();
  expect(cost.record().counts.errors).toBe(2);
  await wrapped.close();
});

test("cost middleware: accumulates tokens across multiple prompts (Codex shape)", async () => {
  const backend = createMockBackend();
  let n = 0;
  backend.onRequest("session/prompt", () => {
    n++;
    return {
      ok: true,
      usage: { input_tokens: 100 * n, output_tokens: 50 * n }
    };
  });
  const cost = createCostMiddleware();
  const wrapped = cost.wrap(createAcpClient(backend));
  await wrapped.start();
  await wrapped.request("session/prompt", {});
  await wrapped.request("session/prompt", {});
  // First: 100 in / 50 out. Second: 200 in / 100 out.
  expect(cost.record().tokens).toEqual({ input: 300, output: 150, total: 450 });
  await wrapped.close();
});

test("cost middleware: accumulates tokens (Gemini shape)", async () => {
  const backend = createMockBackend();
  backend.onRequest("session/prompt", () => ({
    ok: true,
    usageMetadata: {
      promptTokenCount: 80,
      candidatesTokenCount: 40,
      totalTokenCount: 120
    }
  }));
  const cost = createCostMiddleware();
  const wrapped = cost.wrap(createAcpClient(backend));
  await wrapped.start();
  await wrapped.request("session/prompt", {});
  expect(cost.record().tokens).toEqual({ input: 80, output: 40, total: 120 });
  await wrapped.close();
});

test("cost middleware: onUpdate fires after each tracked event", async () => {
  const backend = createMockBackend();
  backend.onRequest("session/prompt", () => ({
    ok: true,
    usage: { input_tokens: 10, output_tokens: 5 }
  }));
  /** @type {number[]} */
  const promptCounts = [];
  const cost = createCostMiddleware({
    onUpdate: (rec) => promptCounts.push(rec.counts.prompts)
  });
  const wrapped = cost.wrap(createAcpClient(backend));
  await wrapped.start();
  await wrapped.request("session/prompt", {});
  await wrapped.request("session/prompt", {});
  await wrapped.close();
  // At least one update with prompt-count 1 and one with 2 (close also fires).
  expect(promptCounts).toContain(1);
  expect(promptCounts).toContain(2);
});

test("cost middleware: record() snapshot is independent (callers can't mutate internal state)", async () => {
  const backend = createMockBackend();
  backend.onRequest("session/prompt", () => ({ ok: true }));
  const cost = createCostMiddleware();
  const wrapped = cost.wrap(createAcpClient(backend));
  await wrapped.start();
  await wrapped.request("session/prompt", {});
  const snapshot = cost.record();
  snapshot.counts.prompts = 999;
  expect(cost.record().counts.prompts).toBe(1);
  await wrapped.close();
});

test("cost middleware: endedAt populated only after close", async () => {
  const backend = createMockBackend();
  const cost = createCostMiddleware();
  const wrapped = cost.wrap(createAcpClient(backend));
  await wrapped.start();
  expect(cost.record().endedAt).toBeNull();
  await wrapped.close();
  expect(cost.record().endedAt).toBeTruthy();
});
