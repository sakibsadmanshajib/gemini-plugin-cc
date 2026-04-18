import test from "node:test";
import assert from "node:assert/strict";

import {
  buildJobEventFromAcpNotification,
  formatBrokerDiagnostic
} from "../plugins/gemini/scripts/lib/gemini.mjs";

import {
  buildBrokerDiagnosticNotification,
  sanitizeDiagnosticMessage
} from "../plugins/gemini/scripts/lib/acp-diagnostics.mjs";

test("buildJobEventFromAcpNotification maps agent_message_chunk to model_text_chunk", () => {
  const event = buildJobEventFromAcpNotification({
    params: {
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello world" }
      }
    }
  });

  assert.equal(event.type, "model_text_chunk");
  assert.equal(event.message, "hello world");
});

test("buildJobEventFromAcpNotification maps tool_call to tool_call with toolName", () => {
  const event = buildJobEventFromAcpNotification({
    params: {
      update: {
        sessionUpdate: "tool_call",
        toolName: "read_file",
        arguments: { path: "README.md" }
      }
    }
  });

  assert.equal(event.type, "tool_call");
  assert.equal(event.toolName, "read_file");
});

test("buildJobEventFromAcpNotification maps file_change to file_change with path and action", () => {
  const event = buildJobEventFromAcpNotification({
    params: {
      update: {
        sessionUpdate: "file_change",
        path: "src/index.ts",
        action: "modify"
      }
    }
  });

  assert.equal(event.type, "file_change");
  assert.equal(event.path, "src/index.ts");
  assert.equal(event.action, "modify");
});

test("buildJobEventFromAcpNotification falls back to acp_notification for unknown updates", () => {
  const event = buildJobEventFromAcpNotification({
    params: {
      update: { sessionUpdate: "something_new" }
    }
  });

  assert.equal(event.type, "acp_notification");
});

test("buildJobEventFromAcpNotification returns null for non-session updates", () => {
  const event = buildJobEventFromAcpNotification({ method: "some/other", params: {} });
  assert.equal(event, null);
});

test("sanitizeDiagnosticMessage strips control chars and bounds length", () => {
  const raw = "\u001b[31merror\u001b[0m: quota\u0000 exceeded" + "x".repeat(2000);
  const clean = sanitizeDiagnosticMessage(raw);

  assert.ok(!clean.includes("\u001b"), "ANSI escapes should be stripped");
  assert.ok(!clean.includes("\u0000"), "null control chars should be stripped");
  assert.ok(clean.length <= 500, `expected length <= 500, got ${clean.length}`);
  assert.match(clean, /quota exceeded/);
});

test("buildBrokerDiagnosticNotification produces a JSON-RPC notification with broker/diagnostic method", () => {
  const notification = buildBrokerDiagnosticNotification({
    source: "broker-child-stderr",
    message: "Warning: authentication refresh required"
  });

  assert.equal(notification.jsonrpc, "2.0");
  assert.equal(notification.method, "broker/diagnostic");
  assert.equal(notification.params.source, "broker-child-stderr");
  assert.match(notification.params.message, /authentication refresh required/);
  assert.equal("id" in notification, false, "notifications must not have an id");
});

test("buildBrokerDiagnosticNotification bounds the diagnostic message", () => {
  const long = "y".repeat(2000);
  const notification = buildBrokerDiagnosticNotification({
    source: "broker-child-stderr",
    message: long
  });

  assert.ok(notification.params.message.length <= 500);
});

test("formatBrokerDiagnostic produces a classification-ready diagnostic event", () => {
  const event = formatBrokerDiagnostic({
    source: "broker-child-stderr",
    message: "429 rate limit exceeded"
  });

  assert.equal(event.type, "diagnostic");
  assert.equal(event.source, "broker-child-stderr");
  assert.match(event.message, /rate limit/);
});
