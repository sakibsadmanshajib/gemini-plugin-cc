import test from "node:test";
import assert from "node:assert/strict";

import { runCommand, binaryAvailable, formatCommandFailure } from "../plugins/gemini/scripts/lib/process.mjs";

test("runCommand captures stdout and stderr", () => {
  const result = runCommand("node", ["-e", 'process.stdout.write("hello")']);
  assert.equal(result.stdout, "hello");
  assert.equal(result.status, 0);
  assert.equal(result.error, null);
});

test("runCommand returns non-zero exit code without throwing", () => {
  const result = runCommand("node", ["-e", "process.exit(42)"]);
  assert.equal(result.status, 42);
  assert.equal(result.error, null);
});

test("formatCommandFailure includes status and stderr", () => {
  const message = formatCommandFailure({
    stdout: "",
    stderr: "file not found",
    status: 1
  });
  assert.match(message, /status 1/);
  assert.match(message, /file not found/);
});

test("binaryAvailable returns true for node", () => {
  assert.equal(binaryAvailable("node"), true);
});

test("binaryAvailable returns false for nonexistent binary", () => {
  assert.equal(binaryAvailable("definitely-not-a-real-binary-xyz"), false);
});
