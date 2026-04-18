import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { __testing as gemini } from "../plugins/gemini/scripts/lib/gemini.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GEMINI_SOURCE = fs.readFileSync(path.join(ROOT, "plugins/gemini/scripts/lib/gemini.mjs"), "utf8");

test("simulateNotificationDispatch keeps thought text out of returned data by default", () => {
  const { text, thoughtText, chunkCount, events } = gemini.simulateNotificationDispatch([
    { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } } },
    { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } } },
    { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ", world" } } } }
  ]);
  assert.equal(text, "Hello, world");
  assert.equal(thoughtText, "");
  assert.equal(chunkCount, 2);
  const kinds = events.map((e) => e.type);
  assert.deepEqual(kinds, ["message_chunk", "thought_chunk", "message_chunk"]);
  assert.equal(events[1].text, undefined);
  assert.equal(events[1].chars, "thinking".length);
});

test("simulateNotificationDispatch streams thought text only when explicitly requested", () => {
  const streamed = [];
  const { thoughtText, thoughtCount, thoughtChars } = gemini.simulateNotificationDispatch([
    { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } } } }
  ], (event) => streamed.push(event), { streamThoughtText: true });

  assert.equal(thoughtText, "");
  assert.equal(thoughtCount, 1);
  assert.equal(thoughtChars, "thinking".length);
  assert.equal(streamed[0].type, "thought_chunk");
  assert.equal(streamed[0].text, "thinking");
});

test("simulateNotificationDispatch sanitizes diagnostic stream event fields", () => {
  const streamed = [];
  const { events } = gemini.simulateNotificationDispatch([
    { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "tool_call", toolName: "read\u001b[2J_file\n[done] forged" } } },
    { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "file_change", path: "src/\u001b]52;c;bad\u0007x\n[phase] forged", action: "write\u001b[H\n[tool] forged" } } }
  ], (event) => streamed.push(event));

  assert.deepEqual(events, streamed);
  const encoded = JSON.stringify(events);
  assert.doesNotMatch(encoded, /[\u001b\u0007]/);
  assert.equal(events[0].toolName, "read_file [done] forged");
  assert.equal(events[1].path, "src/x [phase] forged");
  assert.equal(events[1].action, "write [tool] forged");
});

test("simulateNotificationDispatch fires tool_call and file_change as stream events", () => {
  const { events } = gemini.simulateNotificationDispatch([
    { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "tool_call", toolName: "read_file" } } },
    { method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "file_change", path: "a.mjs", action: "write" } } }
  ]);
  assert.deepEqual(events.map((e) => e.type), ["tool_call", "file_change"]);
  assert.equal(events[0].toolName, "read_file");
  assert.equal(events[1].path, "a.mjs");
  assert.equal(events[1].action, "write");
});

function functionSource(name) {
  const start = GEMINI_SOURCE.indexOf(`export async function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const paramsEnd = GEMINI_SOURCE.indexOf(") {", start);
  assert.notEqual(paramsEnd, -1, `missing ${name} body`);
  const open = paramsEnd + 2;
  let depth = 0;
  for (let i = open; i < GEMINI_SOURCE.length; i++) {
    const ch = GEMINI_SOURCE[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return GEMINI_SOURCE.slice(start, i + 1);
    }
  }
  assert.fail(`could not extract ${name}`);
}

test("runAcpReview forwards thinking and onStream to runAcpPrompt", () => {
  const body = functionSource("runAcpReview");
  assert.match(body, /thinking:\s*options\.thinking/);
  assert.match(body, /onStream:\s*options\.onStream/);
});

test("runAcpAdversarialReview forwards thinking and onStream to runAcpPrompt", () => {
  const body = functionSource("runAcpAdversarialReview");
  assert.match(body, /thinking:\s*options\.thinking/);
  assert.match(body, /onStream:\s*options\.onStream/);
});
