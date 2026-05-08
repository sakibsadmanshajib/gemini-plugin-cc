/**
 * Smoke tests for `scripts/generate-homebrew-formula.mjs`.
 *
 * Coverage stops short of the actual fetch-to-registry path — that
 * would either flake on offline CI or burn unnecessary network. The
 * tests here verify the import graph loads, commander is wired
 * correctly, and the network-failure exit path is reachable. The
 * happy-path render is exercised manually after each release when
 * the homebrew tap is updated.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const SCRIPT = path.join(ROOT, "scripts/generate-homebrew-formula.mjs");

/** @param {string[]} args */
function runScript(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    timeout: 15000,
    // Disable network so the fetch path fails fast / predictably
    // when we expect it to hit the registry.
    env: { ...process.env, NO_NETWORK_TEST: "1" }
  });
}

describe("scripts/generate-homebrew-formula.mjs", () => {
  test("--help prints commander-style usage + flag list", () => {
    const r = runScript(["--help"]);
    expect(r.status).toBe(0);
    const out = r.stdout.toString();
    expect(out).toMatch(/Usage: generate-homebrew-formula/);
    expect(out).toMatch(/--pkg-version/);
    expect(out).toMatch(/--output/);
  });

  test("unknown flag → exit 2", () => {
    const r = runScript(["--bogus"]);
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/unknown option '--bogus'/);
  });

  test("--pkg-version requires a value → exit 2", () => {
    const r = runScript(["--pkg-version"]);
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toMatch(/--pkg-version/);
    expect(r.stderr.toString()).toMatch(/missing/);
  });

  test("--pkg-version of impossible version → exit 1 with fetch error", () => {
    // 0.0.0-not-published-ever would 404 from the registry. Exit 1
    // is the documented failure code when the fetch path errors.
    const r = runScript(["--pkg-version", "0.0.0-not-published-ever"]);
    expect(r.status).toBe(1);
    expect(r.stderr.toString()).toMatch(/generate-homebrew-formula:/);
    expect(r.stderr.toString()).toMatch(/0\.0\.0-not-published-ever/);
  });
});
