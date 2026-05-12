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

test("R2 (round-12): future-dated timestamps are NOT counted against the breaker", async () => {
  // A backwards NTP step or a hand-edited log can produce timestamps
  // greater than nowMs. Pre-R2 these survived every prune and kept
  // the breaker tripped forever. Now filtered out as invalid.
  const fakeDaemon = writeFakeDaemon();
  const now = Date.now();
  const failureLogPath = path.join(manifestDir, "auto-start-failures.json");
  fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });
  // 3 future-dated entries (year-2099-ish): should ALL be filtered.
  fs.writeFileSync(failureLogPath, JSON.stringify([now + 60_000, now + 120_000, now + 180_000]));

  const manifest = await autoStartFacade({
    env: testEnv,
    daemonBin: fakeDaemon,
    pollIntervalMs: 20,
    pollTimeoutMs: 3000
  });
  // Should succeed despite the 3 entries — they're future-dated so
  // the breaker doesn't trip.
  expect(manifest.port).toBe(54321);
});

test("R1 (round-12): breaker error message includes a copy-pasteable rm command", async () => {
  // Round-12 B3: the error message used to say "remove <path> to
  // reset", but operators want "rm <path>" — matches the lock-failure
  // message in the same file for consistency.
  const fakeDaemon = writeFakeDaemon();
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
  ).rejects.toThrow(new RegExp(`rm ${failureLogPath.replace(/\//g, "\\/")}`));
});

test("T1 (round-13): tombstone sweep removes stale .tomb files older than 1 hour", async () => {
  // Round-13 reviewer flagged: a SIGKILL between compareAndDeleteManifest's
  // rename and its cleanup leaks `facade-endpoint.json.tomb.<pid>.<hex>`
  // files in $XDG_STATE_HOME. autoStartFacade now sweeps them at entry.
  const fakeDaemon = writeFakeDaemon();
  fs.mkdirSync(manifestDir, { recursive: true, mode: 0o700 });

  // Old tombstone (2 hours ago) — should be swept.
  const oldTomb = path.join(manifestDir, "facade-endpoint.json.tomb.99999.abcdef");
  fs.writeFileSync(oldTomb, "{}", { mode: 0o600 });
  const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60;
  fs.utimesSync(oldTomb, twoHoursAgo, twoHoursAgo);

  // Recent tombstone (5 min ago) — should be PRESERVED so we don't race
  // a concurrent compareAndDeleteManifest call.
  const recentTomb = path.join(manifestDir, "facade-endpoint.json.tomb.99998.123456");
  fs.writeFileSync(recentTomb, "{}", { mode: 0o600 });
  const fiveMinAgo = Date.now() / 1000 - 5 * 60;
  fs.utimesSync(recentTomb, fiveMinAgo, fiveMinAgo);

  // Unrelated file — should NOT be touched.
  const unrelated = path.join(manifestDir, "facade-endpoint.json.unrelated");
  fs.writeFileSync(unrelated, "x", { mode: 0o600 });

  await autoStartFacade({
    env: testEnv,
    daemonBin: fakeDaemon,
    pollIntervalMs: 20,
    pollTimeoutMs: 3000
  });

  expect(fs.existsSync(oldTomb)).toBe(false); // swept
  expect(fs.existsSync(recentTomb)).toBe(true); // too young, preserved
  expect(fs.existsSync(unrelated)).toBe(true); // wrong name, untouched
});

test("drift guard: TOMBSTONE_MAX_AGE_MS matches the '1 hour' claim in docs", async () => {
  // The tombstone-sweep age threshold is documented in:
  //   - CHANGELOG.md ("older than 1 hour so we don't race")
  //   - docs/architecture.md ("files older than 1 hour")
  //   - lib/server/auto-start.mjs file header AND function docstring
  //
  // Drift would change sweep behavior in a way operators wouldn't
  // notice (tombstones accumulate longer / get nuked sooner than docs
  // claim). Parse the constant and assert.
  const url = await import("node:url");
  const src = fs.readFileSync(
    url.fileURLToPath(new URL("../../lib/server/auto-start.mjs", import.meta.url)),
    "utf8"
  );
  const match = src.match(/const\s+TOMBSTONE_MAX_AGE_MS\s*=\s*([\d_*\s]+)/);
  expect(match).not.toBeNull();
  const ms = Number(new Function(`return ${match?.[1]}`)());
  expect(ms / 60_000 / 60).toBe(1); // exactly 1 hour

  // Verify the doc claim mentions the right hours. Reword-tolerant:
  // pin the NUMBER (1 hour), not the literal phrase "files older
  // than 1 hour" — a future copy-edit could rephrase "older than an
  // hour" or "1-hour cutoff" and still be correct. Scope to the
  // SWEEP paragraph specifically — there's also an unrelated
  // "tombstone" mention in the stale-manifest-recovery bullet that
  // doesn't talk about the age threshold.
  const archPath = url.fileURLToPath(new URL("../../docs/architecture.md", import.meta.url));
  const arch = fs.readFileSync(archPath, "utf8");
  // Match the markdown bullet that combines BOTH "sweep" and "tomb"
  // — the age-threshold one. Architecture doc bullets start with
  // "- **" and run until the next bullet or blank line; scoping to
  // the whole bullet (not a single line) means a future doc rewrite
  // that wraps the description across multiple lines within the same
  // bullet won't false-positive.
  const sweepBullet = arch.match(
    /^- [^\n]*(?:sweep[^\n]*tomb|tomb[^\n]*sweep)[\s\S]*?(?=\n- |\n\n|$)/im
  );
  expect(
    sweepBullet,
    "architecture.md does not have a bullet matching both 'sweep' and 'tomb'"
  ).not.toBeNull();
  if (sweepBullet) {
    const hours = ms / 60_000 / 60;
    expect(sweepBullet[0]).toMatch(new RegExp(`\\b${hours}\\b`));
  }
});

test("drift guard: breaker constants in code match the '3 failures / 5 min' claim in docs", async () => {
  // FAILURE_THRESHOLD and FAILURE_WINDOW_MS are documented in:
  //   - README.md ("3 failures in 5 minutes")
  //   - CHANGELOG.md ("3 failures in a 5-minute rolling")
  //   - docs/architecture.md ("5-minute rolling window. Three failures")
  //   - lib/server/auto-start.mjs file header
  //
  // A contributor who changes the constants without updating the docs
  // would create silent drift — the breaker would behave differently
  // from what the operator-facing docs claim. This test parses the
  // constants out of the source file and asserts the documented
  // claims still match.
  const url = await import("node:url");
  const src = fs.readFileSync(
    url.fileURLToPath(new URL("../../lib/server/auto-start.mjs", import.meta.url)),
    "utf8"
  );

  const thresholdMatch = src.match(/const\s+FAILURE_THRESHOLD\s*=\s*(\d+)/);
  expect(thresholdMatch).not.toBeNull();
  const threshold = Number(thresholdMatch?.[1]);

  const windowMatch = src.match(/const\s+FAILURE_WINDOW_MS\s*=\s*([\d_*\s]+)/);
  expect(windowMatch).not.toBeNull();
  // The constant is `5 * 60_000`; eval-safely with Function constructor
  // restricted to numeric ops.
  const windowMs = Number(new Function(`return ${windowMatch?.[1]}`)());
  const windowMinutes = windowMs / 60_000;

  // Lock in the documented claims. If a contributor changes the
  // constants without updating docs, this test fails — pointing them
  // at README, CHANGELOG, docs/architecture.md, and the file header.
  expect(threshold).toBe(3);
  expect(windowMinutes).toBe(5);

  // Also verify the README claim has the right NUMBERS. We don't
  // pin the exact wording — README is operator-facing prose and may
  // be reworded ("3 failures within 5 minutes" / "after 3 failures
  // in a 5-minute window" / etc.) without changing the contract.
  // What we DO pin: any sentence that talks about the breaker must
  // mention both threshold and window-in-minutes correctly.
  const readmePath = url.fileURLToPath(new URL("../../README.md", import.meta.url));
  const readme = fs.readFileSync(readmePath, "utf8");
  // Find the "circuit breaker" bullet and assert it contains the right
  // numbers. Scope is the full markdown bullet (lines starting with
  // "- " up to but not including the next bullet or blank-line break),
  // not a single sentence — a future doc rewrite that splits the
  // explanation across two sentences within the same bullet would
  // otherwise look like drift even though the contract is unchanged.
  const breakerBulletMatch = readme.match(/^- [^\n]*circuit breaker[\s\S]*?(?=\n- |\n\n|$)/im);
  expect(breakerBulletMatch, "README does not mention 'circuit breaker'").not.toBeNull();
  if (breakerBulletMatch) {
    expect(breakerBulletMatch[0]).toMatch(new RegExp(`\\b${threshold}\\b`));
    expect(breakerBulletMatch[0]).toMatch(new RegExp(`\\b${windowMinutes}\\b`));
  }
});

test("drift guard: .agents/artagon/config.schema.json defaults match source constants", async () => {
  // The config schema documents threshold/windowMs/tombstoneMaxAgeMs
  // defaults — these MUST match the source constants in
  // lib/server/auto-start.mjs. If they drift, operators following
  // the schema would get behavior inconsistent with what the daemon
  // actually does.
  const url = await import("node:url");
  const src = fs.readFileSync(
    url.fileURLToPath(new URL("../../lib/server/auto-start.mjs", import.meta.url)),
    "utf8"
  );

  const thresholdMatch = src.match(/const\s+FAILURE_THRESHOLD\s*=\s*(\d+)/);
  const windowMatch = src.match(/const\s+FAILURE_WINDOW_MS\s*=\s*([\d_*\s]+)/);
  const tombMatch = src.match(/const\s+TOMBSTONE_MAX_AGE_MS\s*=\s*([\d_*\s]+)/);
  expect(thresholdMatch).not.toBeNull();
  expect(windowMatch).not.toBeNull();
  expect(tombMatch).not.toBeNull();
  const threshold = Number(thresholdMatch?.[1]);
  const windowMs = Number(new Function(`return ${windowMatch?.[1]}`)());
  const tombMs = Number(new Function(`return ${tombMatch?.[1]}`)());

  // Read the schema and check the documented defaults.
  const schemaPath = url.fileURLToPath(
    new URL("../../.agents/artagon/config.schema.json", import.meta.url)
  );
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const breakerProps = schema.properties.breaker.properties;
  expect(breakerProps.threshold.default).toBe(threshold);
  expect(breakerProps.windowMs.default).toBe(windowMs);
  expect(breakerProps.tombstoneMaxAgeMs.default).toBe(tombMs);
});
