import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RESCUE = fs.readFileSync(path.join(ROOT, "plugins/gemini/commands/rescue.md"), "utf8");
const REVIEW = fs.readFileSync(path.join(ROOT, "plugins/gemini/commands/review.md"), "utf8");
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

test("README documents --stream-output and compact markers default", () => {
  assert.match(README, /--stream-output/);
  assert.match(README, /compact markers|\[tool\]|\[thinking\]|live progress/i);
});

test("README documents the /gemini:status event tail view", () => {
  assert.match(README, /event tail|recent events|last event/i);
});
