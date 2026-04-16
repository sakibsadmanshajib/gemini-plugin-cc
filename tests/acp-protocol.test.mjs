import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, "..", "plugins", "gemini", "scripts", "lib");

const GEMINI_MJS = fs.readFileSync(path.join(LIB_DIR, "gemini.mjs"), "utf8");
const ACP_PROTOCOL_DTS = fs.readFileSync(path.join(LIB_DIR, "acp-protocol.d.ts"), "utf8");

test("runtime uses session/prompt as the ACP prompt method (per ACP spec)", () => {
  const calls = [];
  const pattern = /client\.request\(\s*"(session\/[a-z_]+)"\s*,\s*\{[^}]*?\bprompt:\s*\[/g;
  for (const m of GEMINI_MJS.matchAll(pattern)) {
    calls.push(m[1]);
  }
  assert.ok(calls.length > 0, "expected a client.request call with a prompt payload");
  assert.ok(
    calls.includes("session/prompt"),
    `expected a session/prompt call but found: ${calls.join(", ")}`
  );
});

test("acp-protocol.d.ts declares session/prompt (not session/send_message)", () => {
  assert.match(
    ACP_PROTOCOL_DTS,
    /"session\/prompt":\s*\{\s*params:\s*PromptParams;\s*result:\s*PromptResult\s*\}/,
    "acp-protocol.d.ts must declare session/prompt in AcpMethodMap"
  );
  assert.doesNotMatch(
    ACP_PROTOCOL_DTS,
    /"session\/send_message"/,
    "acp-protocol.d.ts must not reference the non-canonical session/send_message"
  );
});

test("every session/* method called at runtime is declared in acp-protocol.d.ts", () => {
  const runtimeMethods = new Set();
  const callPattern = /(?:request|notify)\(\s*"(session\/[a-z_]+)"/g;
  for (const m of GEMINI_MJS.matchAll(callPattern)) {
    runtimeMethods.add(m[1]);
  }
  assert.ok(runtimeMethods.size > 0, "expected at least one session/* call in gemini.mjs");

  for (const method of runtimeMethods) {
    assert.match(
      ACP_PROTOCOL_DTS,
      new RegExp(`"${method.replace("/", "\\/")}"`),
      `acp-protocol.d.ts is missing a declaration for ${method}`
    );
  }
});
