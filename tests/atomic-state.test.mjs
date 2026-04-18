import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  withJobMutex,
  withWorkspaceMutex,
  writeJsonAtomic
} from "../plugins/gemini/scripts/lib/atomic-state.mjs";

test("withJobMutex serializes same-jobId writers and parallelises different jobs", async () => {
  const ws = makeTempDir();
  const order = [];
  const slowA = withJobMutex(ws, "job-1", async () => {
    await new Promise((r) => setTimeout(r, 20));
    order.push("A");
  });
  const slowB = withJobMutex(ws, "job-1", async () => {
    order.push("B");
  });
  const parallel = withJobMutex(ws, "job-2", async () => {
    order.push("P");
  });
  await Promise.all([slowA, slowB, parallel]);
  assert.ok(order.includes("A"));
  assert.ok(order.includes("B"));
  assert.ok(order.includes("P"));
  assert.equal(
    order.indexOf("B") > order.indexOf("A"),
    true,
    "A must complete before B on the same jobId"
  );
});

test("withWorkspaceMutex serializes workspace-scoped writers", async () => {
  const ws = makeTempDir();
  const order = [];
  const slowA = withWorkspaceMutex(ws, async () => {
    await new Promise((r) => setTimeout(r, 15));
    order.push("A");
  });
  const fastB = withWorkspaceMutex(ws, async () => {
    order.push("B");
  });
  await Promise.all([slowA, fastB]);
  assert.deepEqual(order, ["A", "B"]);
});

test("writeJsonAtomic writes a complete file atomically", () => {
  const ws = makeTempDir();
  const target = path.join(ws, "state.json");
  writeJsonAtomic(target, { jobs: [{ id: "a" }] });
  const read = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(read.jobs, [{ id: "a" }]);
  const siblings = fs
    .readdirSync(ws)
    .filter((f) => f.startsWith("state.json."));
  assert.equal(siblings.length, 0, "no tmp files should remain");
});

test("writeJsonAtomic does not leave a partial file on write failure", () => {
  const ws = makeTempDir();
  const target = path.join(ws, "state.json");
  fs.writeFileSync(target, JSON.stringify({ jobs: [{ id: "prev" }] }));
  // Force failure: a value containing a BigInt makes JSON.stringify throw.
  assert.throws(() => writeJsonAtomic(target, { bad: 1n }));
  const read = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(
    read.jobs,
    [{ id: "prev" }],
    "target file must be unchanged on failure"
  );
  const siblings = fs
    .readdirSync(ws)
    .filter((f) => f.startsWith("state.json."));
  assert.equal(siblings.length, 0, "tmp file should not remain after failure");
});
