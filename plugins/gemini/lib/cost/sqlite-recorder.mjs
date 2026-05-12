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
/** @type {any | null} */
let cachedInsertStmt = null;
/** @type {string | null} */
let cachedDbPath = null;
// H2: replace one-shot warnedOnce with a counter + cooldown so a sustained
// failure mode keeps producing one warning every WARN_COOLDOWN_MS instead
// of going silent forever. Operators investigating "no stats" can see
// the warning eventually rather than scrolling weeks of stderr.
let failureCount = 0;
let lastWarnedAt = 0;
const WARN_COOLDOWN_MS = 15 * 60_000;

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

  // node:sqlite is a CJS-only built-in. Stable since Node 22.9; on
  // 22.5-22.8 it requires --experimental-sqlite. Engines pin to
  // >=22.5 but the daemon should refuse to start cleanly if sqlite
  // isn't available; here we let the throw propagate to the caller's
  // try/catch + warn path.
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
    // H2: cache the prepared statement across inserts. node:sqlite
    // doesn't auto-finalize per call; preparing on every insert leaks
    // until GC. One statement per DB handle.
    if (!cachedInsertStmt) {
      cachedInsertStmt = db.prepare(
        `INSERT INTO turns
         (ts, backend, model, prompt_chars,
          input_tokens, output_tokens, total_tokens, cached_tokens,
          duration_ms, reason, ok, transport, session_id, trace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      );
    }
    /** @type {any} */
    const u = record.usage ?? {};
    const cached =
      typeof u.cache_read_tokens === "number"
        ? u.cache_read_tokens
        : typeof u.cached_input_tokens === "number"
          ? u.cached_input_tokens
          : null;
    cachedInsertStmt.run(
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
      options.context?.logging?.traceId ?? null,
    );
  } catch (err) {
    // H2: count failures; re-warn periodically so a sustained failure
    // mode doesn't go silent forever after the first stderr line.
    failureCount += 1;
    const now = Date.now();
    if (now - lastWarnedAt > WARN_COOLDOWN_MS) {
      lastWarnedAt = now;
      const message = err instanceof Error ? err.message : String(err);
      try {
        process.stderr.write(
          `[sqlite-recorder] ${failureCount} failed insert(s); last error writing ${dbPath}: ${message}\n`,
        );
      } catch {
        // best-effort
      }
    }
  }
}

/**
 * Close the cached DB connection. Called by:
 *   - tests, between cases
 *   - artagon-openai-server on SIGTERM/SIGINT, so WAL gets checkpointed
 *     and the stats CLI sees the latest rows immediately rather than
 *     waiting for the OS to flush.
 */
export function closeStatsDb() {
  if (cachedDb) {
    try {
      // H2: explicit WAL checkpoint at close so sidecar files are
      // truncated for the next opener. Best-effort.
      cachedDb.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      // best-effort
    }
    try {
      cachedDb.close();
    } catch {
      // best-effort
    }
    cachedDb = null;
    cachedInsertStmt = null;
    cachedDbPath = null;
  }
}

/**
 * H7: Read turn records from the SQLite stats DB and return them in the
 * CostRecord JSONL shape so artagon-stats / lib/cost/aggregate.mjs can
 * consume them uniformly with the JSONL path. Returns an empty array
 * when the DB doesn't exist (caller falls back to JSONL).
 *
 * @param {{
 *   dbPath?: string,
 *   env?: NodeJS.ProcessEnv,
 *   since?: Date,
 *   until?: Date
 * }} [options]
 * @returns {import("./recorder.mjs").CostRecord[]}
 */
export function readTurnStats(options = {}) {
  const env = options.env ?? process.env;
  const dbPath = options.dbPath ?? resolveStatsPath(env, undefined);
  if (!fs.existsSync(dbPath)) return [];
  try {
    const sqlite = /** @type {any} */ (requireFromHere("node:sqlite"));
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000;");
    /** @type {any[]} */
    const params = [];
    let where = "";
    if (options.since) {
      where += (where ? " AND" : " WHERE") + " ts >= ?";
      params.push(options.since.getTime());
    }
    if (options.until) {
      where += (where ? " AND" : " WHERE") + " ts <= ?";
      params.push(options.until.getTime());
    }
    const rows = db
      .prepare(
        `SELECT ts, backend, model, prompt_chars, input_tokens, output_tokens,
                total_tokens, cached_tokens, duration_ms, reason, ok, transport,
                session_id, trace_id
         FROM turns${where} ORDER BY ts ASC;`,
      )
      .all(...params);
    db.close();
    return rows.map(
      (/** @type {any} */ r) =>
        /** @type {import("./recorder.mjs").CostRecord} */ ({
          timestamp: new Date(r.ts).toISOString(),
          backend: r.backend,
          model: r.model,
          promptChars: r.prompt_chars,
          usage: {
            prompt_tokens: r.input_tokens ?? 0,
            completion_tokens: r.output_tokens ?? 0,
            total_tokens: r.total_tokens ?? 0,
            ...(r.cached_tokens != null
              ? { cache_read_tokens: r.cached_tokens }
              : {}),
          },
          durationMs: r.duration_ms,
          reason: r.reason,
          ok: r.ok === 1,
          transport: r.transport ?? undefined,
          sessionId: r.session_id ?? undefined,
        }),
    );
  } catch (err) {
    process.stderr.write(
      `[sqlite-recorder] read failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return [];
  }
}

/**
 * Snapshot of recorder health, useful for /admin endpoints.
 *
 * @returns {{ failureCount: number, lastWarnedAt: number, dbPath: string | null }}
 */
export function getSqliteRecorderHealth() {
  return {
    failureCount,
    lastWarnedAt,
    dbPath: cachedDbPath,
  };
}

/**
 * Reset internal state for tests.
 * @internal
 */
export function _resetSqliteRecorderForTest() {
  closeStatsDb();
  failureCount = 0;
  lastWarnedAt = 0;
}
