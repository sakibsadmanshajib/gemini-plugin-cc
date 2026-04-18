import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESCUE = fs.readFileSync(path.join(ROOT, "plugins/gemini/commands/rescue.md"), "utf8");
const REVIEW = fs.readFileSync(path.join(ROOT, "plugins/gemini/commands/review.md"), "utf8");
const RESCUE_AGENT = fs.readFileSync(path.join(ROOT, "plugins/gemini/agents/gemini-rescue.md"), "utf8");
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

test("rescue.md advertises --thinking <off|low|medium|high>", () => {
  assert.match(RESCUE, /--thinking <off\|low\|medium\|high>/);
});

test("rescue.md advertises --stream-output", () => {
  assert.match(RESCUE, /--stream-output/);
});

test("rescue.md no longer advertises the broken --thinking-budget <number> form", () => {
  assert.doesNotMatch(RESCUE, /--thinking-budget\s*<number>/);
});

test("review.md advertises --thinking and --stream-output", () => {
  assert.match(REVIEW, /--thinking <off\|low\|medium\|high>/);
  assert.match(REVIEW, /--stream-output/);
});

test("review.md no longer advertises the broken --thinking-budget <number> form", () => {
  assert.doesNotMatch(REVIEW, /--thinking-budget\s*<number>/);
});

test("README documents --thinking levels and default", () => {
  assert.match(README, /--thinking <off\|low\|medium\|high>/);
  assert.match(README, /medium/i);
  assert.match(README, /default/i);
});

test("docs explain --thinking is parsed but not delivered per invocation yet", () => {
  for (const [name, source] of [
    ["README.md", README],
    ["commands/rescue.md", RESCUE],
    ["commands/review.md", REVIEW],
    ["agents/gemini-rescue.md", RESCUE_AGENT]
  ]) {
    assert.match(source, /per-invocation thinking override/i, `${name} should mention the runtime limitation`);
    assert.match(source, /one-?shot|one-?time/i, `${name} should mention the warning`);
    assert.match(source, /settings\.json/i, `${name} should point at persistent settings`);
  }
});

test("README thinking section uses t-shirt-sized and tagged progress fences", () => {
  assert.match(README, /t-shirt-sized/);
  assert.doesNotMatch(README, /t-shirt sized/);
  assert.match(README, /```text\n\[session\] created/);
  assert.match(README, /```text\n\[session\] created\n\[tool\] read_file\nHere's what I found/);
  assert.match(README, /```text\nRunning jobs \(1\):/);
});

test("README documents --stream-output and compact markers default", () => {
  assert.match(README, /--stream-output/);
  assert.match(README, /compact markers|\[tool\]|\[thinking\]|live progress/i);
});

test("README documents the /gemini:status event tail view", () => {
  assert.match(README, /event tail|recent events|last event/i);
});
