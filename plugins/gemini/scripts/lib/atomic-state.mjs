/**
 * Promise-chain mutex helpers and atomic JSON write helper.
 *
 * `withJobMutex` and `withWorkspaceMutex` serialize operations keyed by the
 * given identifiers so concurrent readers/writers in the same Node.js process
 * cannot interleave a read-modify-write cycle.
 *
 * `writeJsonAtomic` writes the serialized JSON payload to a unique temporary
 * sibling file and then renames it into place. If serialization or the write
 * itself fails the target file is left untouched and the temp file is cleaned
 * up on a best-effort basis.
 *
 * These helpers are in-process only. They are NOT a substitute for a
 * cross-process file lock — multiple Node processes writing the same file
 * concurrently is out of scope.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const jobMutexes = new Map();
const workspaceMutexes = new Map();

async function runWithMutex(map, key, fn) {
  const prev = map.get(key) ?? Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  // Chain: next waiter awaits the tail of the queue, so concurrent calls
  // serialize in FIFO order.
  map.set(
    key,
    prev.then(() => next)
  );
  try {
    await prev;
    return await fn();
  } finally {
    const tail = map.get(key);
    release();
    // Drop the entry only when the most recently queued promise resolves with
    // no later waiters queued, so the map does not grow unbounded.
    if (tail) {
      tail.then(() => {
        if (map.get(key) === tail) {
          map.delete(key);
        }
      });
    }
  }
}

export function withJobMutex(workspaceRoot, jobId, fn) {
  return runWithMutex(jobMutexes, `${workspaceRoot}::${jobId}`, fn);
}

export function withWorkspaceMutex(workspaceRoot, fn) {
  return runWithMutex(workspaceMutexes, String(workspaceRoot), fn);
}

export function writeJsonAtomic(targetPath, value) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  const tmp = path.join(
    dir,
    `${base}.tmp.${crypto.randomBytes(6).toString("hex")}`
  );

  // Serialize BEFORE opening the temp file so a BigInt / circular value
  // failure does not leave an empty sibling.
  const body = JSON.stringify(value, null, 2);

  try {
    fs.writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }

  try {
    fs.renameSync(tmp, targetPath);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Best-effort cleanup.
    }
    throw error;
  }
}
