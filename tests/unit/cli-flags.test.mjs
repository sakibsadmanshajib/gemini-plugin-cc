/**
 * Unit tests for `lib/cli/flags.mjs` — pure parser, no fs / network /
 * env reads.
 *
 * Coverage groups:
 *
 *   parser:basics       empty argv, bare prompt, multi-word prompt
 *   parser:tri-state    streaming/facade enum mapping, conflict throws
 *   parser:booleans     --no-broker, --wire-log-raw, --no-cost-log,
 *                       --debug, --strict-env
 *   parser:strings      --wire-log, --trace-id, --cost-log, --pricing,
 *                       --facade-key, --model, --cwd (value handling,
 *                       missing-value error, duplicate error)
 *   parser:numeric      --timeout coercion + range validation
 *   parser:separator    `--` boundary, prompt starting with dashes
 *   parser:help         --help / -h
 *   parser:conflicts    --cost-log vs --no-cost-log
 *   parser:errors       unknown flag, missing value, type errors
 *   formatHelp          usage text contract
 */

import { describe, expect, test } from "vitest";

import { formatHelp, parseRunnerArgs } from "#lib/cli/flags.mjs";

describe("parser:basics", () => {
  test("empty argv → empty flags, empty prompt", () => {
    expect(parseRunnerArgs([])).toEqual({
      flags: {},
      prompt: "",
      rest: [],
      helpRequested: false
    });
  });

  test("single positional → that's the prompt", () => {
    const r = parseRunnerArgs(["hello"]);
    expect(r.prompt).toBe("hello");
    expect(r.flags).toEqual({});
  });

  test("multi-word positional → joined with single space", () => {
    const r = parseRunnerArgs(["reply", "with", "ping"]);
    expect(r.prompt).toBe("reply with ping");
    expect(r.rest).toEqual(["reply", "with", "ping"]);
  });

  test("non-array argv → throws TypeError", () => {
    expect(() => parseRunnerArgs(/** @type {any} */ ("hello"))).toThrow(TypeError);
  });
});

describe("parser:tri-state", () => {
  test("--streaming → flags.streaming = 'on'", () => {
    expect(parseRunnerArgs(["--streaming", "x"]).flags.streaming).toBe("on");
  });

  test("--no-streaming → flags.streaming = 'off'", () => {
    expect(parseRunnerArgs(["--no-streaming", "x"]).flags.streaming).toBe("off");
  });

  test("--auto-streaming → flags.streaming = 'default'", () => {
    expect(parseRunnerArgs(["--auto-streaming", "x"]).flags.streaming).toBe("default");
  });

  test("--streaming + --no-streaming → throws with both tokens named", () => {
    expect(() => parseRunnerArgs(["--streaming", "--no-streaming", "x"])).toThrow(
      /--streaming.*--no-streaming.*streaming/
    );
  });

  test("--facade / --no-facade / --auto-facade map the same way", () => {
    expect(parseRunnerArgs(["--facade", "x"]).flags.facade).toBe("on");
    expect(parseRunnerArgs(["--no-facade", "x"]).flags.facade).toBe("off");
    expect(parseRunnerArgs(["--auto-facade", "x"]).flags.facade).toBe("default");
  });

  test("setting the same tri-state twice with the same value is idempotent (no throw)", () => {
    expect(parseRunnerArgs(["--streaming", "--streaming", "x"]).flags.streaming).toBe("on");
  });
});

describe("parser:booleans", () => {
  test("--no-broker → flags.broker = 'disabled'", () => {
    expect(parseRunnerArgs(["--no-broker", "x"]).flags.broker).toBe("disabled");
  });

  test("--wire-log-raw → flags.wireLogRaw = true", () => {
    expect(parseRunnerArgs(["--wire-log-raw", "x"]).flags.wireLogRaw).toBe(true);
  });

  test("--no-cost-log → flags.noCostLog = true", () => {
    expect(parseRunnerArgs(["--no-cost-log", "x"]).flags.noCostLog).toBe(true);
  });

  test("--debug → flags.debug = true", () => {
    expect(parseRunnerArgs(["--debug", "x"]).flags.debug).toBe(true);
  });

  test("--strict-env → flags.strictEnv = true", () => {
    expect(parseRunnerArgs(["--strict-env", "x"]).flags.strictEnv).toBe(true);
  });

  test("setting a boolean flag twice throws", () => {
    expect(() => parseRunnerArgs(["--debug", "--debug", "x"])).toThrow(/already set/);
  });
});

describe("parser:strings", () => {
  test("--wire-log <path> consumes the next token", () => {
    const r = parseRunnerArgs(["--wire-log", "/tmp/x.jsonl", "prompt"]);
    expect(r.flags.wireLog).toBe("/tmp/x.jsonl");
    expect(r.prompt).toBe("prompt");
  });

  test("each string flag maps to the right field", () => {
    expect(parseRunnerArgs(["--trace-id", "t-1", "x"]).flags.traceId).toBe("t-1");
    expect(parseRunnerArgs(["--cost-log", "/p/c", "x"]).flags.costLog).toBe("/p/c");
    expect(parseRunnerArgs(["--pricing", "/p/r.json", "x"]).flags.pricing).toBe("/p/r.json");
    expect(parseRunnerArgs(["--facade-key", "tok", "x"]).flags.facadeKey).toBe("tok");
    expect(parseRunnerArgs(["--model", "sonnet", "x"]).flags.model).toBe("sonnet");
    expect(parseRunnerArgs(["--cwd", "/p", "x"]).flags.cwd).toBe("/p");
  });

  test("missing value at end of argv → throws", () => {
    expect(() => parseRunnerArgs(["--wire-log"])).toThrow(/requires a value/);
  });

  test("next token is itself a flag → missing-value error (not silent consumption)", () => {
    expect(() => parseRunnerArgs(["--wire-log", "--debug"])).toThrow(/requires a value/);
  });

  test("setting the same string flag twice throws with the original token cited", () => {
    expect(() => parseRunnerArgs(["--model", "a", "--model", "b", "x"])).toThrow(/already set/);
  });
});

describe("parser:numeric", () => {
  test("--timeout <ms> coerces decimal integer", () => {
    expect(parseRunnerArgs(["--timeout", "5000", "x"]).flags.timeoutMs).toBe(5000);
  });

  test("--timeout accepts a float", () => {
    expect(parseRunnerArgs(["--timeout", "250.5", "x"]).flags.timeoutMs).toBe(250.5);
  });

  test("--timeout NaN → throws", () => {
    expect(() => parseRunnerArgs(["--timeout", "not-a-number", "x"])).toThrow(
      /positive finite number/
    );
  });

  test("--timeout 0 → throws", () => {
    expect(() => parseRunnerArgs(["--timeout", "0", "x"])).toThrow(/positive finite number/);
  });

  test("--timeout negative → throws", () => {
    expect(() => parseRunnerArgs(["--timeout", "-5", "x"])).toThrow(/positive finite number/);
  });

  test("--timeout Infinity → throws", () => {
    expect(() => parseRunnerArgs(["--timeout", "Infinity", "x"])).toThrow(/positive finite number/);
  });

  test("--timeout with no value → throws", () => {
    expect(() => parseRunnerArgs(["--timeout"])).toThrow(/positive number/);
  });

  test("--timeout set twice → throws", () => {
    expect(() => parseRunnerArgs(["--timeout", "1000", "--timeout", "2000", "x"])).toThrow(
      /already set/
    );
  });
});

describe("parser:separator", () => {
  test("`--` marks the prompt boundary; subsequent tokens are positional even if they look like flags", () => {
    const r = parseRunnerArgs(["--streaming", "--", "--list", "files"]);
    expect(r.flags.streaming).toBe("on");
    expect(r.prompt).toBe("--list files");
    expect(r.rest).toEqual(["--list", "files"]);
  });

  test("bare `--` at end yields empty prompt", () => {
    expect(parseRunnerArgs(["--debug", "--"]).prompt).toBe("");
  });

  test("`--` in the middle of a prompt: everything after counts", () => {
    // (User typed `--` once → boundary; second `--` is a positional.)
    const r = parseRunnerArgs(["--", "first", "--", "second"]);
    expect(r.prompt).toBe("first -- second");
  });

  test("dash-leading positional WITHOUT separator throws unknown-flag error", () => {
    expect(() => parseRunnerArgs(["--unknown-flag"])).toThrow(/Unknown flag/);
  });
});

describe("parser:help", () => {
  test("--help → helpRequested = true, no other side effects", () => {
    const r = parseRunnerArgs(["--help"]);
    expect(r.helpRequested).toBe(true);
  });

  test("-h short form → helpRequested = true", () => {
    expect(parseRunnerArgs(["-h"]).helpRequested).toBe(true);
  });

  test("--help in the middle still parses surrounding flags", () => {
    const r = parseRunnerArgs(["--streaming", "--help", "prompt"]);
    expect(r.helpRequested).toBe(true);
    expect(r.flags.streaming).toBe("on");
  });
});

describe("parser:conflicts", () => {
  test("--cost-log and --no-cost-log together → throws", () => {
    expect(() => parseRunnerArgs(["--cost-log", "/tmp/c.jsonl", "--no-cost-log", "x"])).toThrow(
      /mutually exclusive/
    );
  });
});

describe("parser:errors", () => {
  test("unknown long flag → throws with the flag name", () => {
    expect(() => parseRunnerArgs(["--no-such-flag"])).toThrow(/--no-such-flag/);
  });

  test("unknown short flag → throws with hint about `--`", () => {
    expect(() => parseRunnerArgs(["-z"])).toThrow(/Unknown flag/);
  });
});

describe("formatHelp", () => {
  test("contains the script name and the major flag families", () => {
    const text = formatHelp("codex-prompt");
    expect(text).toMatch(/Usage:.*codex-prompt/);
    expect(text).toMatch(/--streaming/);
    expect(text).toMatch(/--wire-log/);
    expect(text).toMatch(/--cost-log/);
    expect(text).toMatch(/--timeout/);
    expect(text).toMatch(/Examples:/);
  });
});
