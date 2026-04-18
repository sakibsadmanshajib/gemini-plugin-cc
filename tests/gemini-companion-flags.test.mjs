import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMPANION_SRC = fs.readFileSync(path.join(ROOT, "plugins/gemini/scripts/gemini-companion.mjs"), "utf8");

function functionSource(name) {
  const marker = `async function ${name}`;
  const start = COMPANION_SRC.indexOf(marker);
  assert.notEqual(start, -1, `missing ${name}`);
  const paramsEnd = COMPANION_SRC.indexOf(") {", start);
  assert.notEqual(paramsEnd, -1, `missing ${name} body`);
  const open = paramsEnd + 2;
  let depth = 0;
  for (let i = open; i < COMPANION_SRC.length; i++) {
    const ch = COMPANION_SRC[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return COMPANION_SRC.slice(start, i + 1);
    }
  }
  assert.fail(`could not extract ${name}`);
}

test("printUsage lists --thinking and --stream-output on task invocation", () => {
  assert.match(COMPANION_SRC, /--thinking <off\|low\|medium\|high>/);
  assert.match(COMPANION_SRC, /--stream-output/);
});

test("printUsage no longer advertises the broken --thinking-budget <number> flag", () => {
  assert.doesNotMatch(COMPANION_SRC, /--thinking-budget\s*<number>/);
});

test("handleTask parses --thinking as a value option and --stream-output as a boolean option", () => {
  const body = functionSource("handleTask");
  assert.match(body, /valueOptions:\s*\[[^\]]*"thinking"/);
  assert.match(body, /booleanOptions:\s*\[[^\]]*"stream-output"/);
});

test("handleTask validates --thinking against the THINKING_LEVELS set", () => {
  assert.match(COMPANION_SRC, /THINKING_LEVELS/);
});

test("handleReview and handleReviewCommand also parse --thinking and --stream-output", () => {
  for (const name of ["handleReview", "handleReviewCommand"]) {
    const body = functionSource(name);
    assert.match(body, /valueOptions:\s*\[[^\]]*"thinking"/);
    assert.match(body, /booleanOptions:\s*\[[^\]]*"stream-output"/);
  }
});

test("foreground task done stats use returned chunk counters and only emit after errors are checked", () => {
  const body = functionSource("handleTask");
  assert.match(body, /chunks:\s*result\.chunkCount\s*\?\?\s*0/);
  assert.doesNotMatch(body, /chunks:\s*0/);
  assert.ok(
    body.indexOf("if (result.error)") < body.indexOf('type: "done"'),
    "done marker should not be emitted before a failed run throws"
  );
});
