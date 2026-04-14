import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, parseCommandInput } from "../plugins/gemini/scripts/lib/args.mjs";

const REVIEW_SCHEMA = {
  valueOptions: ["base", "scope", "model", "cwd"],
  booleanOptions: ["json", "wait", "background"]
};

const SETUP_SCHEMA = {
  booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
};

test("parseCommandInput splits a quoted raw command argument string", () => {
  const parsed = parseCommandInput(["--base main --scope branch --json"], REVIEW_SCHEMA);

  assert.deepEqual(parsed, {
    options: {
      base: "main",
      scope: "branch",
      json: true
    },
    positionals: []
  });
});

test("parseCommandInput preserves already-tokenized argv", () => {
  const argv = ["--base", "main", "--scope", "branch", "--json"];

  assert.deepEqual(parseCommandInput(argv, REVIEW_SCHEMA), parseArgs(argv, REVIEW_SCHEMA));
});

test("parseCommandInput splits a quoted raw argument token after fixed flags", () => {
  const parsed = parseCommandInput(["--json", "--enable-review-gate --disable-review-gate"], SETUP_SCHEMA);

  assert.deepEqual(parsed, {
    options: {
      json: true,
      "enable-review-gate": true,
      "disable-review-gate": true
    },
    positionals: []
  });
});

test("parseCommandInput drops the empty token from an empty quoted argument string", () => {
  assert.deepEqual(parseCommandInput(["--json", ""], SETUP_SCHEMA), {
    options: {
      json: true
    },
    positionals: []
  });
});

test("parseCommandInput preserves already-tokenized values containing spaces", () => {
  const parsed = parseCommandInput(["--cwd", "/tmp/path with spaces"], REVIEW_SCHEMA);

  assert.deepEqual(parsed, {
    options: {
      cwd: "/tmp/path with spaces"
    },
    positionals: []
  });
});
