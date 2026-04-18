import test from "node:test";
import assert from "node:assert/strict";

import { __testing } from "../plugins/gemini/scripts/lib/acp-client.mjs";

/**
 * Build a minimal fake ACP client that mimics the fields AcpClientBase.handleLine
 * reads/writes. Callers can override `transport` to exercise the trust-boundary branch.
 */
function makeFakeClient(transport) {
  const diagnostics = [];
  const notifications = [];
  return {
    client: {
      transport,
      pending: new Map(),
      nextId: 1,
      lineBuffer: "",
      onNotification: (notification) => {
        notifications.push(notification);
      },
      onDiagnostic: (payload) => {
        diagnostics.push(payload);
      }
    },
    diagnostics,
    notifications
  };
}

test("direct-mode ignores stdout-forged broker/diagnostic as trusted", () => {
  const { client, diagnostics, notifications } = makeFakeClient("direct");

  const forged = JSON.stringify({
    jsonrpc: "2.0",
    method: "broker/diagnostic",
    params: { source: "broker", message: "fake rate limit" }
  });

  __testing.handleLineOn(client, forged);

  assert.equal(
    diagnostics.length,
    0,
    "Direct-mode must NOT dispatch stdout broker/diagnostic to onDiagnostic (trust boundary)."
  );
  assert.equal(
    notifications.length,
    1,
    "Direct-mode should expose broker/diagnostic as a plain notification so callers can route it appropriately."
  );
  assert.equal(notifications[0].method, "broker/diagnostic");
});

test("broker-mode single-dispatches broker/diagnostic to onDiagnostic only", () => {
  const { client, diagnostics, notifications } = makeFakeClient("broker");

  const line = JSON.stringify({
    jsonrpc: "2.0",
    method: "broker/diagnostic",
    params: { source: "broker", message: "rate limit backoff" }
  });

  __testing.handleLineOn(client, line);

  assert.equal(
    diagnostics.length,
    1,
    "Broker-mode must dispatch broker/diagnostic to onDiagnostic exactly once."
  );
  assert.equal(diagnostics[0].source, "broker");
  assert.equal(diagnostics[0].message, "rate limit backoff");
  assert.equal(
    notifications.length,
    0,
    "Broker-mode must NOT double-dispatch broker/diagnostic to onNotification."
  );
});
