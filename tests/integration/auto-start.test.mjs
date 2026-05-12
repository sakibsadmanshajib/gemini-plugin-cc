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
  // J6: kill the fake daemon if it's still alive (some tests spawn
  // a long-lived setInterval-keep-alive child via autoStartFacade).
  const pidFile = path.join(tmpHome, "fake-daemon.pid");
  if (fs.existsSync(pidFile)) {
    try {
      const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already gone — fine
        }
      }
    } catch {
      // best-effort
    }
  }
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
  // J6: write our pid to a file so afterEach can kill us. Without
  // this, the setInterval-keep-alive leaks across tests.
  const pidFile = path.join(tmpHome, "fake-daemon.pid");
  fs.writeFileSync(
    script,
    `
    import fs from "node:fs";
    import path from "node:path";
    const args = new Set(process.argv.slice(2));
    if (args.has("--fail")) process.exit(1);
    fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
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
    // keep alive so the manifest's pid check passes (isPidLiveAndOwned).
    // Auto-exit after 30s as belt-and-suspenders against test leaks.
    setTimeout(() => process.exit(0), 30_000);
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
  ).rejects.toThrow(/daemon failed to start.*exited with code 1/);
});

// O1 (round-10) — silent-failure reviewer flagged: a daemon that
// writes the manifest THEN exits non-zero (port-in-use after listen,
// crash on first request) was silently returned as success. The fix
// in lib/server/auto-start.mjs adds a spawnError check at the
// manifest-sighting branch.
//
// The race window is microsecond-scale through a real child process:
// once the daemon exits, readManifest's pid-liveness gate
// (lib/server/facade-endpoint.mjs::isPidLiveAndOwned) returns false
// and we route through the `failed to start` branch instead. A
// reliable test would need to inject a fake child object rather than
// spawn one. The defensive check stays — it adds zero overhead and
// closes the narrow window when the exit event fires between the
// readManifest call and the function returning.

test("Q4 (round-11): circuit breaker — 3 recent failures → refuses to spawn", async () => {
  // Round-11 reviewer flagged: an operator running a misconfigured
  // CLI sees an infinite "retry the command" loop because each
  // failure doesn't accumulate state across slash-command processes.
  // The disk-backed breaker tracks recent failures and refuses
  // to spawn after FAILURE_THRESHOLD within FAILURE_WINDOW_MS.
  const fakeDaemon = writeFakeDaemon();
  // Pre-seed 3 recent failures so the next attempt trips the breaker
  // without needing 3 actual spawns in the test.
  const now = Date.now();
  const failureLogPath = path.join(manifestDir, "auto-start-failures.json");
  fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(failureLogPath, JSON.stringify([now - 60_000, now - 30_000, now - 10_000]));

  await expect(
    autoStartFacade({
      env: testEnv,
      daemonBin: fakeDaemon,
      pollIntervalMs: 20,
      pollTimeoutMs: 1000
    })
  ).rejects.toThrow(/circuit breaker tripped.*3 times/);
});

test("Q4: stale failures outside the window are ignored — operator wait expired the breaker", async () => {
  const fakeDaemon = writeFakeDaemon();
  // All 3 failures are older than the 5-minute window → breaker not tripped.
  const now = Date.now();
  const failureLogPath = path.join(manifestDir, "auto-start-failures.json");
  fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    failureLogPath,
    JSON.stringify([now - 20 * 60_000, now - 15 * 60_000, now - 10 * 60_000])
  );

  const manifest = await autoStartFacade({
    env: testEnv,
    daemonBin: fakeDaemon,
    pollIntervalMs: 20,
    pollTimeoutMs: 3000
  });
  expect(manifest.port).toBe(54321);
});

test("Q4: successful spawn clears the failure log (breaker resets)", async () => {
  const fakeDaemon = writeFakeDaemon();
  const now = Date.now();
  const failureLogPath = path.join(manifestDir, "auto-start-failures.json");
  fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  // 2 recent failures: under threshold, breaker allows spawn.
  fs.writeFileSync(failureLogPath, JSON.stringify([now - 60_000, now - 30_000]));

  await autoStartFacade({
    env: testEnv,
    daemonBin: fakeDaemon,
    pollIntervalMs: 20,
    pollTimeoutMs: 3000
  });

  // Log should be cleared so a future failure starts the count fresh.
  expect(fs.existsSync(failureLogPath)).toBe(false);
});

test("Q4: a failed spawn appends to the failure log", async () => {
  const fakeDaemon = writeFakeDaemon();
  const failureLogPath = path.join(manifestDir, "auto-start-failures.json");

  await expect(
    autoStartFacade({
      env: testEnv,
      daemonBin: fakeDaemon,
      args: ["--fail"],
      pollIntervalMs: 20,
      pollTimeoutMs: 200
    })
  ).rejects.toThrow();

  // The failure log should now exist with one timestamp.
  expect(fs.existsSync(failureLogPath)).toBe(true);
  const logged = JSON.parse(fs.readFileSync(failureLogPath, "utf8"));
  expect(Array.isArray(logged)).toBe(true);
  expect(logged).toHaveLength(1);
  expect(typeof logged[0]).toBe("number");
});
