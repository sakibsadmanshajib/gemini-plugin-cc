import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { listenOnRestrictedUnixSocket } from "../plugins/gemini/scripts/lib/socket-permissions.mjs";

test("listenOnRestrictedUnixSocket sets restrictive umask only while listening", () => {
  const originalUmask = process.umask();
  let observedUmaskDuringListen = null;
  let observedPath = null;
  let observedCallback = null;

  const server = {
    listen(socketPath, onListening) {
      observedUmaskDuringListen = process.umask();
      observedPath = socketPath;
      observedCallback = onListening;
    }
  };

  try {
    const onListening = () => {};
    listenOnRestrictedUnixSocket(server, "/tmp/gemini-acp.sock", onListening);

    assert.equal(observedPath, "/tmp/gemini-acp.sock");
    assert.equal(observedCallback, onListening);
    assert.equal(observedUmaskDuringListen, 0o177);
    assert.equal(process.umask(), originalUmask);
  } finally {
    process.umask(originalUmask);
  }
});

test("listenOnRestrictedUnixSocket creates a real unix socket with mode 0o600", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX-only: umask and unix socket permissions are not meaningful on Windows");
    return;
  }

  const sockPath = path.join(
    os.tmpdir(),
    `gemini-acp-int-${process.pid}-${Date.now()}.sock`
  );
  try { fs.unlinkSync(sockPath); } catch {}

  const originalUmask = process.umask();
  const server = net.createServer();

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      listenOnRestrictedUnixSocket(server, sockPath, () => resolve());
    });

    const st = fs.statSync(sockPath);
    const mode = st.mode & 0o777;
    assert.equal(
      mode,
      0o600,
      `socket ${sockPath} expected mode 0o600, got 0o${mode.toString(8)}`
    );
    assert.equal(process.umask(), originalUmask, "umask must be restored after listen()");
  } finally {
    await new Promise((resolve) => server.close(() => resolve()));
    try { fs.unlinkSync(sockPath); } catch {}
    process.umask(originalUmask);
  }
});

test("listenOnRestrictedUnixSocket restores umask even when bind fails asynchronously", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX-only: umask semantics not applicable on Windows");
    return;
  }

  const badPath = "/nonexistent-directory-for-socket-test/should-fail.sock";
  const originalUmask = process.umask();
  const server = net.createServer();

  const errPromise = new Promise((resolve) => server.once("error", resolve));
  listenOnRestrictedUnixSocket(server, badPath, () => {});

  const err = await errPromise;
  assert.ok(err instanceof Error, "expected an async bind error on invalid path");
  assert.equal(
    process.umask(),
    originalUmask,
    "umask must be restored even when bind() fails asynchronously"
  );
  server.close();
});
