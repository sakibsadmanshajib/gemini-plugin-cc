#!/usr/bin/env node
/**
 * ACP-mock `gemini` binary for CI / hermetic tests.
 *
 * Pattern adapted from Zed Industries' ACP testbench (their `agent_servers`
 * tests stand up a real executable that speaks the JSON-RPC protocol so
 * the production codepath is exercised end-to-end without a network call
 * to the live model). Same idea here: a real `node` script invoked as
 * `gemini --acp` or `gemini --version` that returns canned JSON-RPC replies.
 *
 * Why a real binary instead of stubbing in JS?
 *   - The runtime spawns `gemini` via `spawn("gemini", ...)` which is a
 *     PATH lookup. There is no injection point — any unit-level mock
 *     would have to monkey-patch `child_process.spawn`, which is brittle
 *     and skips the JSON-RPC framing layer the bug actually lives in.
 *   - A real executable lets us shadow `gemini` on PATH for any test
 *     fixture (no env var, no flag, no ENV-dependent code paths to
 *     teach the runtime).
 *   - Matches Zed's testbench philosophy: production code is unaware
 *     it's talking to a mock.
 *
 * Wire contract:
 *   `gemini --version` → "0.0.0-mock\n", exit 0
 *   `gemini --acp`     → speaks JSON-RPC over stdin/stdout, lines newline-
 *                         framed. Implements the `initialize` and
 *                         `authenticate` methods used by `getGeminiAuthStatus`.
 *
 * Style: nice functional JS with JSDoc types. Frozen enums for protocol
 * tokens, pure functions for state transitions, no classes, no this.
 */

import process from "node:process";
import readline from "node:readline";

/**
 * @typedef {Readonly<{
 *   PROTOCOL_VERSION: 1,
 *   JSONRPC: "2.0",
 *   AUTH_METHOD_OAUTH: "oauth-personal",
 *   MOCK_VERSION: string
 * }>} MockConstants
 */

/** @type {MockConstants} */
const C = Object.freeze({
  PROTOCOL_VERSION: 1,
  JSONRPC: "2.0",
  AUTH_METHOD_OAUTH: "oauth-personal",
  MOCK_VERSION: "0.0.0-mock"
});

/**
 * @typedef {Readonly<"initialize" | "authenticate">} AcpMethod
 * @typedef {Readonly<{
 *   jsonrpc: "2.0",
 *   id: number | string,
 *   method: AcpMethod,
 *   params: Record<string, unknown>
 * }>} JsonRpcRequest
 * @typedef {Readonly<{
 *   jsonrpc: "2.0",
 *   id: number | string,
 *   result: unknown
 * }>} JsonRpcSuccess
 * @typedef {Readonly<{
 *   jsonrpc: "2.0",
 *   id: number | string,
 *   error: Readonly<{ code: number, message: string }>
 * }>} JsonRpcError
 * @typedef {JsonRpcSuccess | JsonRpcError} JsonRpcResponse
 */

/**
 * Build the canned `initialize` reply. Advertises a single oauth-personal
 * auth method so `getGeminiAuthStatus` exercises the loop body once.
 *
 * @param {number | string} id
 * @returns {JsonRpcSuccess}
 */
const replyInitialize = (id) => Object.freeze({
  jsonrpc: C.JSONRPC,
  id,
  result: {
    protocolVersion: C.PROTOCOL_VERSION,
    authMethods: [
      { id: C.AUTH_METHOD_OAUTH, name: "OAuth (Personal)", description: "mock oauth method" }
    ],
    agentCapabilities: {}
  }
});

/**
 * Build the canned `authenticate` reply. By default reports authenticated:true
 * because most tests want the happy path. Override with MOCK_AUTH=fail to
 * simulate the unauthenticated user.
 *
 * @param {number | string} id
 * @param {boolean} ok
 * @returns {JsonRpcResponse}
 */
const replyAuthenticate = (id, ok) => ok
  ? Object.freeze({
    jsonrpc: C.JSONRPC,
    id,
    result: { authenticated: true }
  })
  : Object.freeze({
    jsonrpc: C.JSONRPC,
    id,
    error: { code: -32000, message: "mock: not authenticated" }
  });

/**
 * Pure dispatch: given a parsed request, return the canned response.
 *
 * @param {JsonRpcRequest} req
 * @param {{ authShouldFail: boolean }} cfg
 * @returns {JsonRpcResponse | null}
 */
const dispatch = (req, cfg) => {
  switch (req.method) {
    case "initialize":
      return replyInitialize(req.id);
    case "authenticate":
      return replyAuthenticate(req.id, !cfg.authShouldFail);
    default:
      return Object.freeze({
        jsonrpc: C.JSONRPC,
        id: req.id,
        error: { code: -32601, message: `mock: unknown method ${String(req.method)}` }
      });
  }
};

const writeLine = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

const runVersion = () => {
  process.stdout.write(`${C.MOCK_VERSION}\n`);
  process.exit(0);
};

const runAcp = () => {
  const cfg = Object.freeze({
    authShouldFail: process.env.MOCK_AUTH === "fail"
  });

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    if (req?.jsonrpc !== C.JSONRPC || req.id == null) {
      return;
    }
    const reply = dispatch(req, cfg);
    if (reply) writeLine(reply);
  });

  rl.on("close", () => {
    process.exit(0);
  });
};

const main = () => {
  const args = process.argv.slice(2);
  if (args.includes("--version")) {
    return runVersion();
  }
  if (args.includes("--acp")) {
    return runAcp();
  }
  // Unknown invocation — exit cleanly so binaryAvailable() probes still pass.
  process.stdout.write(`${C.MOCK_VERSION}\n`);
  process.exit(0);
};

main();
