import { EventEmitter } from "node:events";
import test from "node:test";
import assert from "node:assert/strict";

import { ACP_MAX_LINE_BUFFER } from "../plugins/gemini/scripts/lib/acp-client.mjs";
import { __testing as brokerTesting } from "../plugins/gemini/scripts/acp-broker.mjs";

function makeSocket() {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writes = [];
  socket.setEncoding = () => {};
  socket.write = (line) => {
    socket.writes.push(JSON.parse(line));
  };
  return socket;
}

test("client line-buffer overflow diagnostic is sent to the offending socket", () => {
  brokerTesting.resetBrokerState();
  const socket = makeSocket();
  brokerTesting.handleClientConnection(socket);

  socket.emit("data", "x".repeat(ACP_MAX_LINE_BUFFER + 1));

  assert.equal(socket.writes.length, 1);
  assert.equal(socket.writes[0].method, "broker/diagnostic");
  assert.equal(socket.writes[0].params.source, "acp-transport");
  assert.match(socket.writes[0].params.message, /line buffer overflow/);
});
