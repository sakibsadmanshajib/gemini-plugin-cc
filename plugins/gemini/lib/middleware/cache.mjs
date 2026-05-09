/**
 * Cache middleware — content-addressed file cache for opt-in idempotent calls.
 *
 * Cache key: SHA-256(method + JSON-stable params + git HEAD). Storage:
 * `~/.acp-plugins/cache/<key>.json`. Default TTL: 7 days. Opt-in via the
 * `_cache: true` convention on params (slash commands set this when the
 * user passes `--cache`).
 *
 * SAFETY: only caches idempotent reads. The middleware refuses to cache
 * any params that include a tool call expected to write — caller is
 * responsible for setting `_cache: false` for write paths. The default
 * is OFF (`_cache` defaults to undefined → bypass) so this is fail-safe.
 *
 * Cache invalidation: any change in git HEAD produces a different key
 * automatically. Manual invalidation: delete `~/.acp-plugins/cache/`.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_DIR = path.join(os.homedir(), ".acp-plugins", "cache");
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHEABLE_METHODS = new Set(["session/prompt"]);

/**
 * @typedef {import("./compose.mjs").Middleware} Middleware
 *
 * @typedef {{
 *   directory?: string,
 *   ttlMs?: number,
 *   gitHead?: () => string | null
 * }} CacheConfig
 */

/**
 * @returns {string | null}
 */
function defaultGitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    // Not in a git repo or git not on PATH — cache by other inputs only.
    return null;
  }
}

/**
 * Stable JSON serialization that sorts object keys, so two structurally
 * equivalent params produce the same cache key regardless of insertion
 * order.
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

/**
 * @param {CacheConfig} [userConfig]
 * @returns {Middleware}
 */
export function createCacheMiddleware(userConfig = {}) {
  const dir = userConfig.directory ?? DEFAULT_DIR;
  const ttlMs = userConfig.ttlMs ?? DEFAULT_TTL_MS;
  const getGitHead = userConfig.gitHead ?? defaultGitHead;

  // Cache is opt-in (_cache: true on params), so when a user explicitly asks
  // for it and writes silently fail, they get zero signal — every call still
  // round-trips, no perf benefit, no error, just confusion. Surface the FIRST
  // mkdir or write failure to stderr (with the actual reason — EACCES,
  // ENOSPC, EROFS, …) so an operator has a starting point. Subsequent
  // failures stay silent; same root cause repeating, no value in spam.
  let writeFailureLogged = false;

  /**
   * @param {string} stage
   * @param {unknown} err
   */
  function logWriteFailureOnce(stage, err) {
    if (writeFailureLogged) return;
    writeFailureLogged = true;
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[cache] ${stage} failed; subsequent failures silenced — ${message}\n`);
  }

  function ensureDir() {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      logWriteFailureOnce("mkdir", err);
    }
  }

  /**
   * @param {string} method
   * @param {unknown} params
   * @returns {string}
   */
  function buildKey(method, params) {
    const head = getGitHead() ?? "no-git";
    const body = stableStringify({ method, params, head });
    return crypto.createHash("sha256").update(body).digest("hex");
  }

  /**
   * @param {string} key
   * @returns {unknown | null}
   */
  function readCache(key) {
    const file = path.join(dir, `${key}.json`);
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.t !== "number" || Date.now() - parsed.t > ttlMs) {
        return null;
      }
      return parsed.result;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} key
   * @param {unknown} result
   */
  function writeCache(key, result) {
    ensureDir();
    const file = path.join(dir, `${key}.json`);
    try {
      fs.writeFileSync(file, JSON.stringify({ t: Date.now(), result }, null, 2), {
        encoding: "utf8",
        mode: 0o600
      });
    } catch (err) {
      logWriteFailureOnce("write", err);
    }
  }

  return {
    name: "cache",
    wrap(next) {
      return {
        start: () => next.start(),
        async request(method, params) {
          const p = /** @type {any} */ (params);
          const optedIn = p?._cache === true;
          if (!optedIn || !CACHEABLE_METHODS.has(method)) {
            return next.request(method, params);
          }
          const key = buildKey(method, params);
          const cached = readCache(key);
          if (cached !== null) {
            return cached;
          }
          const result = await next.request(method, params);
          writeCache(key, result);
          return result;
        },
        notify: (method, params) => next.notify(method, params),
        onNotification: (handler) => next.onNotification(handler),
        onHealthChange: (handler) => next.onHealthChange(handler),
        healthState: () => next.healthState(),
        close: () => next.close(),
        isOpen: () => next.isOpen()
      };
    }
  };
}
