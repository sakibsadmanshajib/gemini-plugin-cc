import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand, binaryAvailable, formatCommandFailure, spawnDetached } from "../plugins/gemini/scripts/lib/process.mjs";

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

test("spawnDetached returns a child process", () => {
  const child = spawnDetached("node", ["-e", "setTimeout(() => {}, 100)"]);
  assert.ok(child.pid > 0);
});

test("spawnDetached redirects stderr to logFile when provided", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-plugin-test-"));
  const logFile = path.join(dir, "log.txt");

  try {
    const child = spawnDetached("node", ["-e", 'process.stderr.write("hello-stderr")'], { logFile });
    child.ref();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("child did not exit in time")), 5000);
      child.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const content = fs.readFileSync(logFile, "utf8");
    assert.equal(content, "hello-stderr");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("spawnDetached without logFile returns a running child process", () => {
  const child = spawnDetached("node", ["-e", "process.exit(0)"]);
  assert.ok(child.pid > 0);
});
