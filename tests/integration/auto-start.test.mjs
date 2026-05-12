/**
 * Integration tests for `lib/server/auto-start.mjs::autoStartFacade`.
 *
 * Spawns a fake daemon (a Node script that writes a real manifest
 * file at a tmp path) and verifies:
 *   - pre-existing manifest: short-circuits without spawn
 *   - no manifest: spawns + polls + returns the new manifest
 *   - daemon spawn fails to produce a manifest: throws with a path-hint
 */

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { autoStartFacade } from "#lib/server/auto-start.mjs";

/** @type {string} */
let tmpHome;
/** @type {NodeJS.ProcessEnv} */
let testEnv;
/** @type {string} */
let manifestDir;
/** @type {string} */
let manifestFile;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join("/tmp", "auto-start-"));
  testEnv = {
    XDG_STATE_HOME: tmpHome,
    HOME: tmpHome,
    PATH: process.env.PATH
  };
  manifestDir = path.join(tmpHome, "artagon-agent-cli-plugin");
  manifestFile = path.join(manifestDir, "facade-endpoint.json");
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

/**
 * Write a daemon-style manifest at the path autoStartFacade polls
 * for. PID is set to the current process so isPidLiveAndOwned passes.
 *
 * @param {{ port?: number }} [options]
 */
function writeStubManifest(options = {}) {
  fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    manifestFile,
    JSON.stringify({
      host: "127.0.0.1",
      port: options.port ?? 12345,
      pid: process.pid,
      startedAt: new Date().toISOString()
    }),
    { mode: 0o600 }
  );
}

/**
 * Build a fake daemon script. Args:
 *   --delay <ms>  wait this long before writing the manifest
 *   --fail        exit non-zero without writing the manifest
 *
 * The fake daemon runs detached + unref'd by autoStartFacade, so we
 * write a minimal manifest synchronously then exit.
 *
 * @returns {string} absolute path to the fake daemon script
 */
function writeFakeDaemon() {
  const script = path.join(tmpHome, "fake-daemon.mjs");
  fs.writeFileSync(
    script,
    `
    import fs from "node:fs";
    import path from "node:path";
    const args = new Set(process.argv.slice(2));
    if (args.has("--fail")) process.exit(1);
    const dir = ${JSON.stringify(manifestDir)};
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, "facade-endpoint.json"),
      JSON.stringify({
        host: "127.0.0.1",
        port: 54321,
        pid: process.pid,
        startedAt: new Date().toISOString()
      }),
      { mode: 0o600 }
    );
    // keep alive so the manifest's pid check passes (isPidLiveAndOwned)
    setInterval(() => {}, 1000);
    `,
    "utf8"
  );
  return script;
}

test("pre-existing live manifest → returns immediately without spawn", async () => {
  writeStubManifest({ port: 9999 });
  const fakeDaemon = writeFakeDaemon();
  const manifest = await autoStartFacade({
    env: testEnv,
    daemonBin: fakeDaemon
  });
  expect(manifest.port).toBe(9999);
  // The fake-daemon would have written port 54321 if it spawned.
});

test("no manifest → spawns daemon + polls + returns new manifest", async () => {
  const fakeDaemon = writeFakeDaemon();
  expect(fs.existsSync(manifestFile)).toBe(false);
  const manifest = await autoStartFacade({
    env: testEnv,
    daemonBin: fakeDaemon,
    pollIntervalMs: 20,
    pollTimeoutMs: 3000
  });
  expect(manifest.port).toBe(54321);
});

test("daemon fails to write manifest → throws with the file path in the message", async () => {
  const fakeDaemon = writeFakeDaemon();
  // The --fail arg makes our fake daemon exit immediately without writing.
  await expect(
    autoStartFacade({
      env: testEnv,
      daemonBin: fakeDaemon,
      args: ["--fail"],
      pollIntervalMs: 20,
      pollTimeoutMs: 200
    })
  ).rejects.toThrow(/never appeared at .*facade-endpoint\.json/);
});
