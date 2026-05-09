/**
 * JSONL fixture replayer for ACP tests.
 *
 * A fixture is a newline-delimited JSON file where each line is a tagged
 * record:
 *
 *   {"dir": "out", "msg": { "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {...} }}
 *   {"dir": "in",  "msg": { "jsonrpc": "2.0", "id": 1, "result": {...} }}
 *   {"dir": "in",  "msg": { "jsonrpc": "2.0", "method": "session/update", "params": {...} }}
 *   {"dir": "out", "msg": { "jsonrpc": "2.0", "method": "session/cancel", "params": {...} }}
 *
 * `dir: "out"` is a message the client UNDER TEST is expected to send.
 * `dir: "in"` is a message the fake server should push at this point in the
 * sequence (after the preceding "out" has been observed).
 *
 * The replayer asserts that outbound messages match the fixture's "out"
 * records in order (with fuzzy matching on volatile fields like timestamps
 * and request ids — see `normalizeForMatch`) and pushes "in" records to the
 * client between outbound assertions.
 */

import fs from "node:fs";

/**
 * @typedef {{ dir: "in" | "out", msg: object }} FixtureRecord
 */

/**
 * Strip volatile fields from a message so two messages compare equal even
 * when they differ on transient ids or timestamps.
 *
 * @param {object} msg
 * @returns {object}
 */
function normalizeForMatch(msg) {
  if (!msg || typeof msg !== "object") return msg;
  const out = { ...msg };
  // Request ids are nondeterministic; the replayer matches by method+params.
  out.id = undefined;
  // Strip any embedded timestamp fields.
  if (out.params && typeof out.params === "object") {
    out.params = { ...out.params };
    out.params.timestamp = undefined;
    out.params._otel = undefined;
  }
  return out;
}

/**
 * @typedef {{
 *   write(message: object): void,
 *   on(event: "line", handler: (message: object) => void): void,
 *   close(): void
 * }} ReplayTransport
 */

/**
 * Replay a fixture against a fake-server transport.
 *
 * Returns a Promise that resolves when every "out" record has been observed
 * in order, or rejects if an outbound message diverges from the fixture.
 *
 * @param {string} fixturePath - Absolute path to a `.jsonl` fixture.
 * @param {ReplayTransport} transport - The server-half transport from `createPairedTransport`.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ matched: number, total: number }>}
 */
export function replayFixture(fixturePath, transport, options = {}) {
  const records = parseFixture(fixturePath);
  const timeoutMs = options.timeoutMs ?? 5000;
  const outboundExpected = records.filter((r) => r.dir === "out");

  return new Promise((resolve, reject) => {
    let cursor = 0;
    let matched = 0;
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Fixture replay timed out after ${timeoutMs}ms; matched ${matched}/${outboundExpected.length} outbound messages.`
        )
      );
    }, timeoutMs);

    /**
     * Push consecutive "in" records to the client until we hit the next
     * "out" record (or the end of the fixture).
     */
    const drainInbound = () => {
      while (cursor < records.length && records[cursor].dir === "in") {
        transport.write(records[cursor].msg);
        cursor += 1;
      }
      if (cursor >= records.length) {
        clearTimeout(timer);
        resolve({ matched, total: outboundExpected.length });
      }
    };

    transport.on("line", (msg) => {
      if (cursor >= records.length || records[cursor].dir !== "out") return;
      const expected = records[cursor].msg;
      const got = normalizeForMatch(msg);
      const want = normalizeForMatch(expected);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        clearTimeout(timer);
        reject(
          new Error(
            `Fixture divergence at record ${cursor}:\n` +
              `  expected: ${JSON.stringify(want)}\n` +
              `  got:      ${JSON.stringify(got)}`
          )
        );
        return;
      }
      cursor += 1;
      matched += 1;
      drainInbound();
    });

    // Prime the pump: if the fixture starts with inbound records (server
    // pushes a notification before the client sends anything), deliver them.
    drainInbound();
  });
}

/**
 * Parse a JSONL fixture into structured records. Empty lines and `#`-prefixed
 * lines are ignored to allow comments in fixtures.
 *
 * @param {string} fixturePath
 * @returns {FixtureRecord[]}
 */
export function parseFixture(fixturePath) {
  const text = fs.readFileSync(fixturePath, "utf8");
  /** @type {FixtureRecord[]} */
  const out = [];
  let lineNum = 0;
  for (const raw of text.split("\n")) {
    lineNum += 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `Fixture ${fixturePath}:${lineNum} — invalid JSON: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (parsed.dir !== "in" && parsed.dir !== "out") {
      throw new Error(`Fixture ${fixturePath}:${lineNum} — record must have "dir": "in" or "out"`);
    }
    if (!parsed.msg || typeof parsed.msg !== "object") {
      throw new Error(`Fixture ${fixturePath}:${lineNum} — record must have an object "msg"`);
    }
    out.push(parsed);
  }
  return out;
}
