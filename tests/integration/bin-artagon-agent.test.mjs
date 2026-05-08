/**
 * Smoke tests for the `bin/artagon-agent.mjs` CLI entry point.
 *
 * Tests argv parsing + import-graph integrity:
 *   - --version prints the package version + exits 0
 *   - --help prints usage + exits 0
 *   - no args exits 2 + stderr usage
 *   - unknown backend exits 2 + actionable error message
 *   - missing prompt exits 2
 *   - unknown flag exits 2 with the offending flag named
 *
 * Does NOT spawn any real backend CLI; all backend invocations would
 * proceed to runStatelessTurn → spawn `claude`/`codex`/`gemini` which
 * we don't want hitting the network in CI. Per-runner spawn lifecycle
 * is covered by the existing integration tests.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const BIN = path.join(ROOT, "bin/artagon-agent.mjs");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

/** @param {string[]} args */
function runBin(args) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    timeout: 10000
  });
}

describe("bin/artagon-agent.mjs", () => {
  test("--version prints package version and exits 0", () => {
    const r = runBin(["--version"]);
    expect(r.status).toBe(0);
    expect(r.stdout.toString().trim()).toBe(PKG.version);
  });

  test("--help prints usage and exits 0", () => {
    const r = runBin(["--help"]);
    expect(r.status).toBe(0);
    // commander format: "Usage: artagon-agent [options] <backend> <prompt...>"
    expect(r.stdout.toString()).toMatch(/Usage: artagon-agent/);
    expect(r.stdout.toString()).toMatch(/<backend>/);
    expect(r.stdout.toString()).toMatch(/claude, codex, gemini/);
  });

  test("no args: exits 2 + stderr usage", () => {
    const r = runBin([]);
    expect(r.status).toBe(2);
    // commander: "error: missing required argument 'backend'"
    expect(r.stderr.toString()).toMatch(/missing required argument 'backend'/);
    expect(r.stdout.toString()).toBe("");
  });

  test("unknown backend: exits 2 with actionable message", () => {
    const r = runBin(["bedrock", "hi"]);
    expect(r.status).toBe(2);
    const err = r.stderr.toString();
    // Commander surfaces our InvalidArgumentError("must be one of …")
    // wrapped in: "error: command-argument value 'bedrock' is invalid…"
    expect(err).toMatch(/'bedrock'/);
    expect(err).toMatch(/claude, codex, gemini/);
  });

  test("backend without prompt: exits 2", () => {
    const r = runBin(["claude"]);
    expect(r.status).toBe(2);
    // commander: "error: missing required argument 'prompt'"
    expect(r.stderr.toString()).toMatch(/missing required argument 'prompt'/);
  });

  test("unknown flag: exits 2 with the flag named", () => {
    const r = runBin(["--bogus", "claude", "hi"]);
    expect(r.status).toBe(2);
    // commander: "error: unknown option '--bogus'"
    expect(r.stderr.toString()).toMatch(/unknown option '--bogus'/);
  });

  test("invalid --timeout-ms: exits 2", () => {
    const r = runBin(["--timeout-ms", "not-a-number", "claude", "hi"]);
    expect(r.status).toBe(2);
    // commander surfaces our InvalidArgumentError("must be a positive integer")
    expect(r.stderr.toString()).toMatch(/--timeout-ms/);
    expect(r.stderr.toString()).toMatch(/positive integer/);
  });
});
