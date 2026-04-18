import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION_SRC = fs.readFileSync(path.join(ROOT, "plugins/gemini/scripts/gemini-companion.mjs"), "utf8");

test("printUsage lists --thinking and --stream-output on task invocation", () => {
  assert.match(COMPANION_SRC, /--thinking <off\|low\|medium\|high>/);
  assert.match(COMPANION_SRC, /--stream-output/);
});

test("printUsage no longer advertises the broken --thinking-budget <number> flag", () => {
  assert.doesNotMatch(COMPANION_SRC, /--thinking-budget\s*<number>/);
});

test("handleTask parses --thinking as a value option and --stream-output as a boolean option", () => {
  assert.match(COMPANION_SRC, /handleTask[\s\S]{0,1200}valueOptions:\s*\[[^\]]*"thinking"/);
  assert.match(COMPANION_SRC, /handleTask[\s\S]{0,1200}booleanOptions:\s*\[[^\]]*"stream-output"/);
});

test("handleTask validates --thinking against the THINKING_LEVELS set", () => {
  assert.match(COMPANION_SRC, /THINKING_LEVELS/);
});

test("handleReview and handleReviewCommand also parse --thinking and --stream-output", () => {
  assert.match(COMPANION_SRC, /handleReview\b[\s\S]{0,1200}valueOptions:\s*\[[^\]]*"thinking"/);
  assert.match(COMPANION_SRC, /handleReview\b[\s\S]{0,1200}booleanOptions:\s*\[[^\]]*"stream-output"/);
  assert.match(COMPANION_SRC, /handleReviewCommand[\s\S]{0,1200}valueOptions:\s*\[[^\]]*"thinking"/);
  assert.match(COMPANION_SRC, /handleReviewCommand[\s\S]{0,1200}booleanOptions:\s*\[[^\]]*"stream-output"/);
});
