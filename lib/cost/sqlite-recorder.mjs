/**
 * SQLite-backed stats recorder — companion to the JSONL recorder in
 * `recorder.mjs`. Designed for the long-lived facade daemon, where a
 * single process writes every turn and stats CLIs read concurrently.
 *
 * Uses Node's built-in `node:sqlite` (stable since Node 22.5). No
 * external dep. Opens the DB lazily on first insert; reuses a single
 * connection for the daemon's lifetime.
 *
 * **Pragmas applied at open:**
 *   - `journal_mode=WAL`   readers don't block the writer (G5 from
 *                          architecture review). Adds two sidecar
 *                          files (`-wal`, `-shm`); operators see them
 *                          alongside `stats.sqlite`.
 *   - `busy_timeout=5000`  block-and-retry inside the C layer for up
 *                          to 5s before throwing SQLITE_BUSY. Hides
 *                          read/write contention from callers.
 *   - `synchronous=NORMAL` good throughput at WAL's default safety.
 *
 * **Schema:**
 *   turns(
 *     id INTEGER PRIMARY KEY AUTOINCREMENT,
 *     ts INTEGER NOT NULL,           -- UNIX ms epoch
 *     backend TEXT NOT NULL,         -- claude / codex / gemini
 *     model TEXT,                    -- nullable; not all turns identify
 *     prompt_chars INTEGER NOT NULL,
 *     input_tokens INTEGER,
 *     output_tokens INTEGER,
 *     total_tokens INTEGER,
 *     cached_tokens INTEGER,
 *     duration_ms INTEGER NOT NULL,
 *     reason TEXT,                   -- end_turn / max_tokens / error_*
 *     ok INTEGER NOT NULL,           -- 1/0 (boolean)
 *     transport TEXT,                -- TransportName
 *     session_id TEXT,               -- nullable; populated by streaming
 *     trace_id TEXT                  -- nullable; from context.logging.traceId
 *   )
 *   CREATE INDEX IF NOT EXISTS idx_turns_ts        ON turns(ts);
 *   CREATE INDEX IF NOT EXISTS idx_turns_session   ON turns(session_id);
 *
 * **Failure mode:** silent. Observability MUST NOT block dispatch.
 * Errors get one stderr warning per process, then are ignored.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const requireFromHere = createRequire(import.meta.url);

const SERVICE_DIR = "artagon-agent-cli-plugin";
const DEFAULT_DB_NAME = "stats.sqlite";

/**
 * @typedef {import("./recorder.mjs").CostRecord} CostRecord
 */

/** @type {any | null} */
let cachedDb = null;
/** @type {string | null} */
let cachedDbPath = null;
let warnedOnce = false;

/**
 * Resolve the on-disk path for the stats DB:
 *   1. context.cost.sqlitePath if set
 *   2. $XDG_STATE_HOME/artagon-agent-cli-plugin/stats.sqlite
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {import("#lib/agent-context.mjs").AgentContext} [context]
 * @returns {string}
 */
function resolveStatsPath(env, context) {
  const fromContext = context?.cost?.sqlitePath;
  if (typeof fromContext === "string" && fromContext.length > 0) {
    return fromContext;
  }
  const xdg = env.XDG_STATE_HOME?.trim();
  const root = xdg ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(root, SERVICE_DIR, DEFAULT_DB_NAME);
}

/**
 * Open (or return the cached) sqlite database. Lazy — the daemon may
 * never log a turn (e.g. a /health probe) and we don't want to create
 * the file/dir until the first real write.
 *
 * @param {string} dbPath
 * @returns {any | null}
 */
function openDatabase(dbPath) {
  if (cachedDb && cachedDbPath === dbPath) return cachedDb;
  if (cachedDb && cachedDbPath !== dbPath) {
    // Path changed — close the old one. This isn't expected in a
    // long-lived daemon, but tests/operators may swap paths.
    try {
      cachedDb.close();
    } catch {
      // best-effort
    }
    cachedDb = null;
    cachedDbPath = null;
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });

  // node:sqlite is a CJS-only built-in (stable in Node 22.5+);
  // createRequire bridges from this ESM module to it. Engines pin
  // to >=22.5 so the import is always available.
  const sqlite = /** @type {any} */ (requireFromHere("node:sqlite"));
  const db = new sqlite.DatabaseSync(dbPath);

  // Pragmas — WAL + busy_timeout are the two that matter for the
  // single-writer-many-readers pattern the daemon uses.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");

  // Schema + indexes. IF NOT EXISTS makes this idempotent across daemon
  // restarts on an existing DB.
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      backend TEXT NOT NULL,
      model TEXT,
      prompt_chars INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      cached_tokens INTEGER,
      duration_ms INTEGER NOT NULL,
      reason TEXT,
      ok INTEGER NOT NULL,
      transport TEXT,
      session_id TEXT,
      trace_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
    CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id);
  `);

  cachedDb = db;
  cachedDbPath = dbPath;
  return db;
}

/**
 * Insert one turn row into the stats DB. Best-effort.
 *
 * @param {CostRecord} record
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   context?: import("#lib/agent-context.mjs").AgentContext
 * }} [options]
 */
export function insertTurnStat(record, options = {}) {
  if (options.context?.cost?.disabled === true) return;
  const env = options.context?.env ?? options.env ?? process.env;
  const dbPath = resolveStatsPath(env, options.context);
  try {
    const db = openDatabase(dbPath);
    if (!db) return;
    const stmt = db.prepare(
      `INSERT INTO turns
       (ts, backend, model, prompt_chars,
        input_tokens, output_tokens, total_tokens, cached_tokens,
        duration_ms, reason, ok, transport, session_id, trace_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`
    );
    /** @type {any} */
    const u = record.usage ?? {};
    const cached =
      typeof u.cache_read_tokens === "number"
        ? u.cache_read_tokens
        : typeof u.cached_input_tokens === "number"
          ? u.cached_input_tokens
          : null;
    stmt.run(
      Date.parse(record.timestamp) || Date.now(),
      record.backend,
      record.model ?? null,
      record.promptChars,
      u.prompt_tokens ?? null,
      u.completion_tokens ?? null,
      u.total_tokens ?? null,
      cached,
      record.durationMs,
      record.reason ?? null,
      record.ok ? 1 : 0,
      record.transport ?? null,
      record.sessionId ?? null,
      options.context?.logging?.traceId ?? null
    );
  } catch (err) {
    if (!warnedOnce) {
      warnedOnce = true;
      const message = err instanceof Error ? err.message : String(err);
      try {
        process.stderr.write(
          `[sqlite-recorder] disabled — failed to write ${dbPath}: ${message}\n`
        );
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Close the cached DB connection (test seam + graceful daemon shutdown).
 */
export function closeStatsDb() {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      // best-effort
    }
    cachedDb = null;
    cachedDbPath = null;
  }
}

/**
 * Reset internal state for tests.
 * @internal
 */
export function _resetSqliteRecorderForTest() {
  closeStatsDb();
  warnedOnce = false;
}
