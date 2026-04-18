import test from "node:test";
import assert from "node:assert/strict";

import { createStreamHandler, STREAM_MODES } from "../plugins/gemini/scripts/lib/stream-output.mjs";

function captureWriter() {
  const out = [];
  return { writer: (s) => { out.push(s); return true; }, out };
}

test("STREAM_MODES enumerates the two accepted modes", () => {
  assert.deepEqual(STREAM_MODES, ["markers", "passthrough"]);
});

test("markers mode prints session + tool + dot + thinking + file + done", () => {
  const { writer, out } = captureWriter();
  const handler = createStreamHandler({ mode: "markers", json: false, writer });
  handler({ type: "phase", message: "session_created" });
  handler({ type: "tool_call", toolName: "read_file" });
  handler({ type: "message_chunk", text: "hello" });
  handler({ type: "message_chunk", text: " world" });
  handler({ type: "thought_chunk", text: "pondering" });
  handler({ type: "file_change", path: "x.mjs", action: "write" });
  handler({ type: "done", stats: { tools: 1, files: 1, chunks: 2, thoughts: 1, elapsedMs: 1200 } });
  const joined = out.join("");
  assert.match(joined, /\[session\] created/);
  assert.match(joined, /\[tool\] read_file/);
  assert.match(joined, /\.\./);
  assert.match(joined, /\[thinking\]/);
  assert.match(joined, /\[file\] write x\.mjs/);
  assert.match(joined, /\[done\].*1\.2s.*1 tool.*1 file.*2 chunks.*1 thought/);
});

test("markers mode sanitizes terminal controls and embedded newlines in marker fields", () => {
  const { writer, out } = captureWriter();
  const handler = createStreamHandler({ mode: "markers", json: false, writer });

  handler({ type: "tool_call", toolName: "read\u001b[2J_file\n[done] forged" });
  handler({
    type: "file_change",
    action: "write\u001b]52;c;SGVsbG8=\u0007\n[tool] forged",
    path: "src/\u001b[Hdanger\n[phase] forged.mjs"
  });

  const joined = out.join("");
  assert.doesNotMatch(joined, /[\u001b\u0007]/);

  const lines = joined.trimEnd().split("\n");
  assert.equal(lines.length, 2, "embedded newlines must not create forged marker lines");
  assert.match(lines[0], /^\[tool\] read_file \[done\] forged$/);
  assert.match(lines[1], /^\[file\] write \[tool\] forged src\/danger \[phase\] forged\.mjs$/);
});

test("passthrough mode writes raw message and thought text", () => {
  const { writer, out } = captureWriter();
  const handler = createStreamHandler({ mode: "passthrough", json: false, writer });
  handler({ type: "message_chunk", text: "Hello, " });
  handler({ type: "message_chunk", text: "world." });
  handler({ type: "thought_chunk", text: "I am reasoning." });
  const joined = out.join("");
  assert.match(joined, /Hello, world\./);
  assert.match(joined, /thought: I am reasoning\./);
});

test("markers mode under json=true produces no output", () => {
  const { writer, out } = captureWriter();
  const handler = createStreamHandler({ mode: "markers", json: true, writer });
  handler({ type: "tool_call", toolName: "read_file" });
  handler({ type: "message_chunk", text: "x" });
  assert.deepEqual(out, []);
});

test("passthrough mode under json=true still writes (user opted in)", () => {
  const { writer, out } = captureWriter();
  const handler = createStreamHandler({ mode: "passthrough", json: true, writer });
  handler({ type: "message_chunk", text: "hi" });
  assert.ok(out.length > 0);
});

test("writer EPIPE does not throw out of handler", () => {
  const throwing = () => {
    const err = new Error("EPIPE"); err.code = "EPIPE"; throw err;
  };
  const handler = createStreamHandler({ mode: "markers", json: false, writer: throwing });
  assert.doesNotThrow(() => handler({ type: "tool_call", toolName: "x" }));
});

test("writer ERR_STREAM_DESTROYED does not throw out of handler", () => {
  const throwing = () => {
    const err = new Error("stream destroyed"); err.code = "ERR_STREAM_DESTROYED"; throw err;
  };
  const handler = createStreamHandler({ mode: "markers", json: false, writer: throwing });
  assert.doesNotThrow(() => handler({ type: "tool_call", toolName: "x" }));
});

test("writer with unexpected error throws out of handler (does not silently swallow)", () => {
  const throwing = () => {
    throw new TypeError("writer broken");
  };
  const handler = createStreamHandler({ mode: "markers", json: false, writer: throwing });
  assert.throws(() => handler({ type: "tool_call", toolName: "x" }), /writer broken/);
});

test("unknown event type is ignored safely", () => {
  const { writer, out } = captureWriter();
  const handler = createStreamHandler({ mode: "markers", json: false, writer });
  handler({ type: "unknown" });
  assert.deepEqual(out, []);
});

test("null or undefined event is ignored safely", () => {
  const { writer, out } = captureWriter();
  const handler = createStreamHandler({ mode: "markers", json: false, writer });
  handler(null);
  handler(undefined);
  handler("not-an-object");
  assert.deepEqual(out, []);
});

test("non-session phase messages render with [phase] label, not [session]", () => {
  const { writer, out } = captureWriter();
  const handler = createStreamHandler({ mode: "markers", json: false, writer });
  handler({ type: "phase", message: "thinking:high" });
  handler({ type: "phase", message: "session_loaded" });
  const joined = out.join("");
  assert.match(joined, /\[phase\] thinking:high/);
  assert.match(joined, /\[session\] loaded/);
  assert.doesNotMatch(joined, /\[session\] thinking:high/);
});

test("invalid mode throws", () => {
  assert.throws(() => createStreamHandler({ mode: "nope", json: false, writer: () => {} }), /invalid stream mode/i);
});
