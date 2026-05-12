/**
 * Unit tests for `lib/runners/facade-dispatch.mjs::consumeSseStream`.
 *
 * J7 — Step 4b's SSE client had zero coverage. These tests drive the
 * parser with hand-crafted SSE bytes (including chunk splits across
 * SSE event boundaries) and assert the accumulator + onUpdate behavior.
 */

import { expect, test, vi } from "vitest";

import { consumeSseStream } from "#lib/runners/facade-dispatch.mjs";

/**
 * Build a fake Response whose body emits the given chunks in order.
 * Each chunk is a Uint8Array — tests can split SSE events across
 * chunks to exercise the parser's stream-state handling.
 *
 * @param {string[]} chunks
 */
function fakeResponse(chunks) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    }
  });
  return /** @type {Response} */ (/** @type {unknown} */ ({ body: stream }));
}

/** Build an empty TurnResult-shaped accumulator. */
function newTurn() {
  return /** @type {any} */ ({
    text: "",
    thoughtText: "",
    chunkCount: 0,
    chunkChars: 0,
    thoughtCount: 0,
    thoughtChars: 0,
    toolCalls: [],
    toolResults: [],
    usage: null,
    reason: null,
    model: null,
    sessionId: null,
    updates: []
  });
}

test("happy path: parses delta chunks → accumulates text + invokes onUpdate", async () => {
  const sse =
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"the "}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"answer"}}]}\n\n' +
    'data: {"choices":[{"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  const turn = newTurn();
  const onUpdate = vi.fn();
  await consumeSseStream(fakeResponse([sse]), turn, onUpdate);
  expect(turn.text).toBe("the answer");
  expect(turn.chunkCount).toBe(2);
  expect(turn.chunkChars).toBe("the answer".length);
  expect(turn.reason).toBe("stop");
  expect(onUpdate).toHaveBeenCalledTimes(2);
  expect(onUpdate.mock.calls[0][0]).toEqual({
    sessionUpdate: "agent_message_chunk",
    content: { text: "the " }
  });
});

test("chunk split across event boundary → parser reassembles", async () => {
  // Same SSE as above but the first delta is split across two TCP chunks
  // mid-event. The parser must hold state until the \n\n terminator.
  const chunks = [
    'data: {"choices":[{"delta":{"content":"the ',
    'answer"}}]}\n\n',
    'data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  ];
  const turn = newTurn();
  await consumeSseStream(fakeResponse(chunks), turn);
  expect(turn.text).toBe("the answer");
  expect(turn.reason).toBe("stop");
});

test("usage chunk is captured", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n' +
    "data: [DONE]\n\n";
  const turn = newTurn();
  await consumeSseStream(fakeResponse([sse]), turn);
  expect(turn.usage).toEqual({
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15
  });
});

test("model is captured from the first chunk that carries it", async () => {
  const sse =
    'data: {"model":"claude-sonnet-4-6","choices":[{"delta":{"content":"x"}}]}\n\n' +
    "data: [DONE]\n\n";
  const turn = newTurn();
  await consumeSseStream(fakeResponse([sse]), turn);
  expect(turn.model).toBe("claude-sonnet-4-6");
});

test("malformed JSON line is silently skipped", async () => {
  const sse =
    "data: not-json-at-all\n\n" +
    'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
    "data: [DONE]\n\n";
  const turn = newTurn();
  await consumeSseStream(fakeResponse([sse]), turn);
  expect(turn.text).toBe("ok");
});

test("[DONE] terminator stops accumulation", async () => {
  const sse =
    'data: {"choices":[{"delta":{"content":"first"}}]}\n\n' +
    "data: [DONE]\n\n" +
    // This event arrives after [DONE]; depending on parser behavior
    // it may or may not be invoked. Even if it is, onEvent's
    // [DONE]-return prevents accumulation.
    'data: {"choices":[{"delta":{"content":"AFTER_DONE"}}]}\n\n';
  const turn = newTurn();
  await consumeSseStream(fakeResponse([sse]), turn);
  expect(turn.text).toBe("first");
  expect(turn.text).not.toContain("AFTER_DONE");
});

test("no onUpdate callback → still accumulates turn state", async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' + "data: [DONE]\n\n";
  const turn = newTurn();
  // Pass undefined onUpdate.
  await consumeSseStream(fakeResponse([sse]), turn, undefined);
  expect(turn.text).toBe("hello");
});

test("J4: mid-stream error → stderr marker + rethrow", async () => {
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  const enc = new TextEncoder();
  /** @type {ReadableStreamDefaultController<Uint8Array>} */
  let ctrl;
  const errStream = new ReadableStream({
    start(controller) {
      ctrl = controller;
    }
  });
  const response = /** @type {Response} */ (/** @type {unknown} */ ({ body: errStream }));

  const turn = newTurn();
  const consumePromise = consumeSseStream(response, turn);

  // Microtask hop so the for-await picks up the first chunk before
  // we throw the controller into error state.
  await new Promise((r) => setImmediate(r));
  ctrl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
  await new Promise((r) => setImmediate(r));
  ctrl.error(new Error("transport reset"));

  await expect(consumePromise).rejects.toThrow(/transport reset/);
  // The stderr marker is the key correctness signal — operator can
  // correlate stdout partial-output with the failure cause.
  expect(stderrSpy).toHaveBeenCalled();
  /** @type {string} */
  const msg = String(stderrSpy.mock.calls[0][0]);
  expect(msg).toMatch(/\[facade\] streaming response interrupted/);
  expect(msg).toMatch(/transport reset/);

  stderrSpy.mockRestore();
});

test("J5: TextDecoder is flushed at end-of-stream", async () => {
  // The SSE bytes terminate cleanly so this test exercises the
  // happy path where decode(stream:false) at end runs without
  // throwing or losing data.
  const sse = 'data: {"choices":[{"delta":{"content":"end"}}]}\n\ndata: [DONE]\n\n';
  const turn = newTurn();
  await consumeSseStream(fakeResponse([sse]), turn);
  expect(turn.text).toBe("end");
});
