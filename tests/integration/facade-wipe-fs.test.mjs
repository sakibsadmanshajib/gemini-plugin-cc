/**
 * Filesystem-truth integration tests for K2 stale-manifest wipe.
 *
 * Round-7 test-coverage reviewer flagged that the unit tests in
 * tests/unit/run-via-facade.test.mjs mock `deleteManifest` and only
 * assert call-count. A regression that turned `deleteManifest` into
 * a no-op would pass every unit test while leaving the manifest on
 * disk — and the next slash-command's auto-start would hit the same
 * dead daemon's manifest and fail again.
 *
 * This file deliberately does NOT mock the facade-endpoint module.
 * It writes a real manifest at $XDG_STATE_HOME, points it at an
 * unreachable port, runs `runViaFacade` against it, then asserts the
 * file is actually gone from disk (or, in the race-safe variant,
 * still there).
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { runViaFacade } from "#lib/runners/facade-dispatch.mjs";
import {
  compareAndDeleteManifest,
  manifestPaths,
  readManifest,
  writeManifest
} from "#lib/server/facade-endpoint.mjs";

/**
 * Bind a server briefly to get a definitely-unbound port, then close.
 * Subsequent connects to this port return ECONNREFUSED on all sane
 * kernels (modulo TIME_WAIT races we don't need to worry about for
 * a freshly-released local port).
 *
 * @returns {Promise<number>}
 */
async function unboundLocalPort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = /** @type {import("node:net").AddressInfo} */ (server.address());
  await new Promise((resolve) => server.close(resolve));
  return addr.port;
}

/** @type {string} */
let tmpHome;
/** @type {string} */
let manifestFile;
/** @type {NodeJS.ProcessEnv} */
let savedEnv;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join("/tmp", "facade-wipe-fs-"));
  // Set BOTH XDG_STATE_HOME (where the manifest lives) and pretend
  // HOME too so any fallback resolves into the tmp dir. The runViaFacade
  // env is read via context?.env ?? options.env ?? process.env, so we
  // also mutate process.env to keep the test self-contained.
  savedEnv = { ...process.env };
  process.env.XDG_STATE_HOME = tmpHome;

  const { file } = manifestPaths(process.env);
  manifestFile = file;
});

afterEach(() => {
  process.env = savedEnv;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test("K2 end-to-end: ECONNREFUSED against an unreachable port → manifest file is actually deleted", async () => {
  // Get a definitely-unbound port (bind, snapshot, release). pid is
  // our own process so isPidLiveAndOwned passes inside readManifest.
  const port = await unboundLocalPort();
  writeManifest(
    {
      host: "127.0.0.1",
      port,
      pid: process.pid,
      autoKey: null
    },
    process.env
  );
  expect(fs.existsSync(manifestFile)).toBe(true);

  await expect(
    runViaFacade(
      BACKEND_NAMES.CLAUDE,
      { prompt: "hi", timeoutMs: 5_000 },
      // Build a minimal frozen context so the env propagates.
      /** @type {any} */ ({ env: process.env })
    )
  ).rejects.toThrow(/Stale manifest deleted/);

  // The whole point: the manifest is REALLY gone from the filesystem.
  // A regression that turned deleteManifest into a no-op would fail
  // here even with the mocked unit tests still green.
  expect(fs.existsSync(manifestFile)).toBe(false);
});

// Note: a sibling "non-wipe-eligible failure leaves manifest alone"
// case is covered deterministically by the AbortError unit test in
// tests/unit/run-via-facade.test.mjs ("non-network rejection does NOT
// delete manifest"). Reproducing it here with a real 1ms timeout is
// racy because the OS connect can finish with ECONNREFUSED before
// the AbortController fires under load.

test("S1 (round-13): compareAndDeleteManifest commits when pid+port match", async () => {
  writeManifest({ host: "127.0.0.1", port: 12345, pid: process.pid, autoKey: null }, process.env);
  expect(fs.existsSync(manifestFile)).toBe(true);

  const result = compareAndDeleteManifest({ pid: process.pid, port: 12345 }, process.env);
  expect(result.committed).toBe(true);
  expect(fs.existsSync(manifestFile)).toBe(false);
});

test("S1: compareAndDeleteManifest RESTORES when pid+port mismatch", async () => {
  // Pre-existing manifest from a DIFFERENT daemon than what we expect
  // to delete. The atomic rename+verify+link path should restore it.
  writeManifest({ host: "127.0.0.1", port: 22222, pid: process.pid, autoKey: null }, process.env);

  // Caller captured manifest with port 11111 (long-dead daemon) but
  // disk now has port 22222 (a fresher daemon). The function must NOT
  // wipe the on-disk file.
  const result = compareAndDeleteManifest({ pid: process.pid, port: 11111 }, process.env);
  expect(result.committed).toBe(false);
  expect(result.reason).toBe("different_manifest_restored");

  // The fresher manifest is still on disk, intact.
  expect(fs.existsSync(manifestFile)).toBe(true);
  const restored = readManifest(process.env);
  expect(restored?.port).toBe(22222);
});

test("S1: compareAndDeleteManifest reports already_gone when nothing on disk", async () => {
  // No manifest written. Function should report committed:false /
  // manifest_already_gone rather than throwing.
  expect(fs.existsSync(manifestFile)).toBe(false);
  const result = compareAndDeleteManifest({ pid: process.pid, port: 5000 }, process.env);
  expect(result.committed).toBe(false);
  expect(result.reason).toBe("manifest_already_gone");
});
