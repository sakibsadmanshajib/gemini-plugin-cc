/**
 * Unit tests for `lib/server/facade-endpoint.mjs` — the manifest read/
 * write helpers used by `bin/artagon-openai-server.mjs` (writer) and
 * the dispatcher's `ARTAGON_USE_FACADE=1` path (reader).
 *
 * Gates exercised:
 *   - writeManifest produces a 0o600 file under a 0o700 dir
 *   - readManifest returns null when file is missing / malformed
 *   - readManifest returns null when pid is dead
 *   - readManifest returns null when the file is owned by a different uid
 *   - deleteManifest is silent on ENOENT but warns on other errors
 *   - manifest never contains the bearer key itself
 */

import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import {
  deleteManifest,
  manifestPaths,
  readManifest,
  writeManifest
} from "#lib/server/facade-endpoint.mjs";

/** @type {string} */
let tmpRoot;
/** @type {NodeJS.ProcessEnv} */
let testEnv;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join("/tmp", "fep-"));
  testEnv = {
    ...process.env,
    XDG_STATE_HOME: tmpRoot
  };
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("manifestPaths: respects XDG_STATE_HOME override", () => {
  const { dir, file } = manifestPaths(testEnv);
  expect(dir.startsWith(tmpRoot)).toBe(true);
  expect(file.endsWith("facade-endpoint.json")).toBe(true);
});

test("writeManifest: creates 0o600 file under 0o700 dir", () => {
  const written = writeManifest(
    {
      host: "127.0.0.1",
      port: 3000,
      pid: process.pid,
      autoKey: null
    },
    testEnv
  );
  const { dir, file } = manifestPaths(testEnv);
  const dirStat = fs.statSync(dir);
  const fileStat = fs.statSync(file);
  // Mask off setuid/setgid; we care about the rwx bits.
  expect(dirStat.mode & 0o777).toBe(0o700);
  expect(fileStat.mode & 0o777).toBe(0o600);
  expect(written.host).toBe("127.0.0.1");
  expect(written.port).toBe(3000);
  expect(written.pid).toBe(process.pid);
  expect(typeof written.startedAt).toBe("string");
});

test("writeManifest: idempotent — overwrite replaces previous content", () => {
  writeManifest({ host: "127.0.0.1", port: 3000, pid: process.pid, autoKey: null }, testEnv);
  writeManifest({ host: "127.0.0.1", port: 4000, pid: process.pid, autoKey: null }, testEnv);
  const m = readManifest(testEnv);
  expect(m?.port).toBe(4000);
});

test("writeManifest: never includes a raw bearer key", () => {
  writeManifest(
    {
      host: "127.0.0.1",
      port: 3000,
      pid: process.pid,
      autoKey: {
        store: "keychain",
        retrieveCommand: "security find-generic-password ..."
      }
    },
    testEnv
  );
  const { file } = manifestPaths(testEnv);
  const text = fs.readFileSync(file, "utf8");
  // Smoke-test: no field literally named "key" or "secret" in the
  // manifest. The autoKey block holds only the retrieve-command.
  expect(text).not.toMatch(/"key":/);
  expect(text).not.toMatch(/"secret":/);
  expect(text).toMatch(/retrieveCommand/);
});

test("readManifest: returns null when file missing", () => {
  expect(readManifest(testEnv)).toBeNull();
});

test("readManifest: returns null on malformed JSON", () => {
  const { dir, file } = manifestPaths(testEnv);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, "not json {{{");
  expect(readManifest(testEnv)).toBeNull();
});

test("readManifest: returns null when pid is dead", () => {
  // 999999 is a high PID unlikely to be allocated. process.kill(pid, 0)
  // will throw ESRCH for a nonexistent pid.
  writeManifest({ host: "127.0.0.1", port: 3000, pid: 999999, autoKey: null }, testEnv);
  expect(readManifest(testEnv)).toBeNull();
});

test("readManifest: returns null when host is missing", () => {
  const { dir, file } = manifestPaths(testEnv);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ port: 3000, pid: process.pid }));
  fs.chmodSync(file, 0o600);
  expect(readManifest(testEnv)).toBeNull();
});

test("readManifest: returns null when port is non-integer", () => {
  const { dir, file } = manifestPaths(testEnv);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ host: "127.0.0.1", port: "3000", pid: process.pid }));
  fs.chmodSync(file, 0o600);
  expect(readManifest(testEnv)).toBeNull();
});

test("readManifest: returns parsed manifest when all gates pass", () => {
  writeManifest({ host: "127.0.0.1", port: 3000, pid: process.pid, autoKey: null }, testEnv);
  const m = readManifest(testEnv);
  expect(m?.host).toBe("127.0.0.1");
  expect(m?.port).toBe(3000);
  expect(m?.pid).toBe(process.pid);
});

test("deleteManifest: silent on ENOENT", () => {
  // No file exists. Must not throw.
  expect(() => deleteManifest(testEnv)).not.toThrow();
});

test("deleteManifest: removes the file when present", () => {
  writeManifest({ host: "127.0.0.1", port: 3000, pid: process.pid, autoKey: null }, testEnv);
  const { file } = manifestPaths(testEnv);
  expect(fs.existsSync(file)).toBe(true);
  deleteManifest(testEnv);
  expect(fs.existsSync(file)).toBe(false);
});

test("read after delete: returns null", () => {
  writeManifest({ host: "127.0.0.1", port: 3000, pid: process.pid, autoKey: null }, testEnv);
  expect(readManifest(testEnv)).not.toBeNull();
  deleteManifest(testEnv);
  expect(readManifest(testEnv)).toBeNull();
});
