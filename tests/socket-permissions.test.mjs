import test from "node:test";
import assert from "node:assert/strict";
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
