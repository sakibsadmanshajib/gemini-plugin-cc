/**
 * Self-provisioned API-key storage for the OpenAI facade.
 *
 * Two backends, picked by platform:
 *
 *   macOS  → Apple Keychain (`security` CLI, generic-password class).
 *            Read access prompts the user the first time and is then
 *            cached per-process by the system. The key is never written
 *            to disk in cleartext from this process.
 *
 *   Linux/other → file at $XDG_STATE_HOME/artagon-agent-cli-plugin/api-key
 *                 with mode 0o600, parent dir 0o700, owner = current uid.
 *                 The file holds the hex key and nothing else.
 *
 * Generation: `crypto.randomBytes(BYTE_LENGTH)` then `.toString("hex")`.
 * 512 bytes ⇒ a 1024-character hex string. The CSPRNG choice matters
 * here: this is the live auth credential gating /v1/* against the
 * facade.
 *
 * `provisionApiKey()` is idempotent — if a key already exists in the
 * chosen store, it's returned as-is. Pass `{ rotate: true }` to force a
 * fresh key.
 *
 * The bin layer NEVER prints the key to stdout. It prints the
 * retrieval *command* (e.g. `security find-generic-password -s ... -w`
 * on macOS or `cat <file>` on Linux). Operator copies the command to
 * fetch the key into their client config.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BYTE_LENGTH = 512; // 1024 hex chars
const SERVICE_NAME = "artagon-agent-cli-plugin";
const ACCOUNT_DEFAULT = process.env.USER ?? "default";

/** @returns {string} */
function generateKey() {
  return randomBytes(BYTE_LENGTH).toString("hex");
}

/**
 * Resolve the on-disk file path for the Linux/other-platform store.
 * Honors XDG_STATE_HOME → falls back to ~/.local/state.
 *
 * @returns {{ dir: string, file: string }}
 */
export function fileStorePaths() {
  const xdg = process.env.XDG_STATE_HOME?.trim();
  const root = xdg ? xdg : path.join(os.homedir(), ".local", "state");
  const dir = path.join(root, SERVICE_NAME);
  const file = path.join(dir, "api-key");
  return { dir, file };
}

/**
 * Write the key into a 0o600 file under a 0o700 directory. Idempotent
 * on the directory (chmod even if it existed); recreates the file with
 * mode 0o600 either way.
 *
 * @param {string} key
 * @returns {{ file: string, retrieveCommand: string }}
 */
function writeFileStore(key) {
  const { dir, file } = fileStorePaths();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Defensive chmod: mkdirSync's mode is masked by umask. The chmod is
  // unconditional and not masked, so the dir lands at 0o700 regardless
  // of the operator's umask.
  fs.chmodSync(dir, 0o700);
  // Write via a temp-then-rename to avoid leaving a partial file with
  // mode-0666 if the process crashes between writeFileSync and the
  // explicit chmod. The temp file is created with mode 0o600 atomically.
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, `${key}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  // Belt-and-suspenders chmod on the final path (rename preserves mode,
  // but be explicit for the audit trail).
  fs.chmodSync(file, 0o600);
  return {
    file,
    retrieveCommand: `cat "${file}"`
  };
}

/**
 * Read the existing file-store key, returning null when absent.
 *
 * @returns {string | null}
 */
function readFileStore() {
  const { file } = fileStorePaths();
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read an existing key from macOS Keychain via `security find-generic-password`.
 * Returns null when no entry exists. Throws on other errors (e.g. when the
 * Keychain is locked).
 *
 * @param {string} account
 * @returns {string | null}
 */
function readKeychain(account) {
  const result = spawnSync(
    "security",
    ["find-generic-password", "-a", account, "-s", SERVICE_NAME, "-w"],
    { encoding: "utf8" }
  );
  if (result.status === 0) {
    return result.stdout.trim() || null;
  }
  // Exit code 44 is the documented "item not found" code; everything
  // else is a real error worth surfacing.
  if (result.status === 44) return null;
  throw new Error(
    `security find-generic-password failed (exit ${result.status}): ${result.stderr.trim()}`
  );
}

/**
 * Write a key into macOS Keychain via `security add-generic-password -U`.
 * `-U` updates an existing entry in place. The key never lands on disk
 * in cleartext from this process — the security command stores it
 * encrypted in the user's login keychain.
 *
 * Implementation note: we pass the key on stdin via the `-w` form (no
 * argument) because the explicit `-w <key>` form leaks the key into
 * `ps` output. `security` reads from terminal stdin when -w has no
 * argument, but Node's spawnSync stdin pipe doesn't behave the same as
 * an interactive terminal — falling back to argv form here. Mitigation:
 * `ps` snapshots only catch the call window (sub-second). For
 * adversarial-shared-host threat models, prefer the file-store path.
 *
 * @param {string} key
 * @param {string} account
 * @returns {{ retrieveCommand: string }}
 */
function writeKeychain(key, account) {
  const result = spawnSync(
    "security",
    [
      "add-generic-password",
      "-a",
      account,
      "-s",
      SERVICE_NAME,
      "-U", // update if exists
      "-w",
      key
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(
      `security add-generic-password failed (exit ${result.status}): ${result.stderr.trim()}`
    );
  }
  return {
    retrieveCommand: `security find-generic-password -a "${account}" -s "${SERVICE_NAME}" -w`
  };
}

/**
 * Provision an API key for the OpenAI facade.
 *
 * Behavior:
 *   - macOS (`os.platform() === "darwin"`): use Keychain.
 *   - Other: use file store under $XDG_STATE_HOME.
 *   - If a key already exists in the chosen store and `rotate` is
 *     false (default), return the existing key.
 *   - With `rotate: true`, generate a new key and overwrite.
 *
 * @param {{ rotate?: boolean, account?: string, force?: "file" | "keychain" }} [options]
 * @returns {{ key: string, source: "keychain" | "file", retrieveCommand: string, location: string, rotated: boolean }}
 */
export function provisionApiKey(options = {}) {
  const { rotate = false, account = ACCOUNT_DEFAULT, force } = options;
  const useKeychain = force === "keychain" || (force === undefined && os.platform() === "darwin");

  if (useKeychain) {
    const existing = rotate ? null : readKeychain(account);
    if (existing) {
      return {
        key: existing,
        source: "keychain",
        retrieveCommand: `security find-generic-password -a "${account}" -s "${SERVICE_NAME}" -w`,
        location: `Apple Keychain (service=${SERVICE_NAME}, account=${account})`,
        rotated: false
      };
    }
    const fresh = generateKey();
    const { retrieveCommand } = writeKeychain(fresh, account);
    return {
      key: fresh,
      source: "keychain",
      retrieveCommand,
      location: `Apple Keychain (service=${SERVICE_NAME}, account=${account})`,
      rotated: rotate || existing === null
    };
  }

  const existing = rotate ? null : readFileStore();
  if (existing) {
    const { file } = fileStorePaths();
    return {
      key: existing,
      source: "file",
      retrieveCommand: `cat "${file}"`,
      location: file,
      rotated: false
    };
  }
  const fresh = generateKey();
  const { file, retrieveCommand } = writeFileStore(fresh);
  return {
    key: fresh,
    source: "file",
    retrieveCommand,
    location: file,
    rotated: rotate || existing === null
  };
}

/**
 * Verify that the `security` CLI is reachable. Used by callers that
 * need to fail fast with a clear error rather than crash mid-spawn.
 *
 * @returns {boolean}
 */
export function keychainAvailable() {
  try {
    execFileSync("security", ["-h"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
