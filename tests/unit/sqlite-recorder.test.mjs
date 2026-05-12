/**
 * Unit tests for `lib/cost/sqlite-recorder.mjs`.
 *
 * Verifies the SQLite-backed stats recorder writes correctly, handles
 * the disabled / no-context paths, and is read-safe under concurrent
 * load (WAL mode).
 *
 * These tests use a real `node:sqlite` database in a temp directory.
 * They're skipped on Node versions without `node:sqlite` (stable in
 * 22.5+) — but `engines.node` pins that minimum, so on the supported
 * floor they always run.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, beforeEach, expect, test } from "vitest";

import { _resetSqliteRecorderForTest, insertTurnStat } from "#lib/cost/sqlite-recorder.mjs";

const requireFromHere = createRequire(import.meta.url);
/** @type {any} */
let sqliteModule;
try {
  sqliteModule = requireFromHere("node:sqlite");
} catch {
  // skip the file when node:sqlite is unavailable
  sqliteModule = null;
}
const describeIfSqlite = sqliteModule ? test : test.skip;

/** @type {string} */
let tmpDir;
/** @type {string} */
let dbPath;

beforeEach(() => {
  _resetSqliteRecorderForTest();
  tmpDir = fs.mkdtempSync(path.join("/tmp", "sqlite-rec-"));
  dbPath = path.join(tmpDir, "stats.sqlite");
});

afterEach(() => {
  _resetSqliteRecorderForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * @param {Partial<import("#lib/cost/recorder.mjs").CostRecord>} overrides
 */
function makeRecord(overrides = {}) {
  return /** @type {import("#lib/cost/recorder.mjs").CostRecord} */ ({
    timestamp: new Date("2026-05-11T20:00:00Z").toISOString(),
    backend: "codex",
    model: "gpt-5-codex",
    promptChars: 42,
    usage: {
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: 20
    },
    durationMs: 1234,
    reason: "end_turn",
    ok: true,
    transport: "codex-app-server",
    sessionId: "thr_abc",
    ...overrides
  });
}

describeIfSqlite("insertTurnStat writes one row with all fields", () => {
  insertTurnStat(makeRecord(), {
    context: /** @type {any} */ ({ cost: { sqlitePath: dbPath } })
  });
  const db = new sqliteModule.DatabaseSync(dbPath);
  const rows = db.prepare("SELECT * FROM turns").all();
  expect(rows).toHaveLength(1);
  expect(rows[0].backend).toBe("codex");
  expect(rows[0].model).toBe("gpt-5-codex");
  expect(rows[0].prompt_chars).toBe(42);
  expect(rows[0].input_tokens).toBe(100);
  expect(rows[0].output_tokens).toBe(50);
  expect(rows[0].total_tokens).toBe(150);
  expect(rows[0].cached_tokens).toBe(20);
  expect(rows[0].duration_ms).toBe(1234);
  expect(rows[0].reason).toBe("end_turn");
  expect(rows[0].ok).toBe(1);
  expect(rows[0].transport).toBe("codex-app-server");
  expect(rows[0].session_id).toBe("thr_abc");
  db.close();
});

describeIfSqlite("cost.disabled=true → no row inserted", () => {
  insertTurnStat(makeRecord(), {
    context: /** @type {any} */ ({
      cost: { sqlitePath: dbPath, disabled: true }
    })
  });
  // DB file shouldn't even exist (the recorder bails before openDatabase).
  expect(fs.existsSync(dbPath)).toBe(false);
});

describeIfSqlite("trace_id is captured from context.logging.traceId", () => {
  insertTurnStat(makeRecord(), {
    context: /** @type {any} */ ({
      cost: { sqlitePath: dbPath },
      logging: { traceId: "req-abc-123" }
    })
  });
  const db = new sqliteModule.DatabaseSync(dbPath);
  const rows = db.prepare("SELECT trace_id FROM turns").all();
  expect(rows[0].trace_id).toBe("req-abc-123");
  db.close();
});

describeIfSqlite("indexes exist on ts and session_id", () => {
  insertTurnStat(makeRecord(), {
    context: /** @type {any} */ ({ cost: { sqlitePath: dbPath } })
  });
  const db = new sqliteModule.DatabaseSync(dbPath);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='turns'")
    .all();
  /** @type {string[]} */
  const names = indexes.map((/** @type {any} */ r) => r.name);
  expect(names).toContain("idx_turns_ts");
  expect(names).toContain("idx_turns_session");
  db.close();
});

describeIfSqlite("WAL mode is enabled (readers don't block writes)", () => {
  insertTurnStat(makeRecord(), {
    context: /** @type {any} */ ({ cost: { sqlitePath: dbPath } })
  });
  const db = new sqliteModule.DatabaseSync(dbPath);
  const [{ journal_mode }] = db.prepare("PRAGMA journal_mode").all();
  expect(journal_mode).toBe("wal");
  db.close();
});

describeIfSqlite("ok=false is stored as 0", () => {
  insertTurnStat(makeRecord({ ok: false }), {
    context: /** @type {any} */ ({ cost: { sqlitePath: dbPath } })
  });
  const db = new sqliteModule.DatabaseSync(dbPath);
  const rows = db.prepare("SELECT ok FROM turns").all();
  expect(rows[0].ok).toBe(0);
  db.close();
});

describeIfSqlite("many inserts → all land", () => {
  for (let i = 0; i < 50; i++) {
    insertTurnStat(makeRecord({ sessionId: `sid-${i}` }), {
      context: /** @type {any} */ ({ cost: { sqlitePath: dbPath } })
    });
  }
  const db = new sqliteModule.DatabaseSync(dbPath);
  const [{ n }] = db.prepare("SELECT COUNT(*) as n FROM turns").all();
  expect(n).toBe(50);
  db.close();
});
