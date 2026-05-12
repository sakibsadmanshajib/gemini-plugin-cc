/**
 * Runner CLI flag parser — recognizes the per-turn flags accepted by
 * slash-command scripts and bin entries, and emits a structured object
 * that boundary builders translate into an `AgentContext`.
 *
 * No internal dependencies. Pure parse function — no fs / network /
 * env reads. Boundary builders are responsible for layering env-var
 * fallback and validating filesystem-sensitive values.
 *
 * Designed around three principles flagged by the adversarial review:
 *
 *   1. Tri-state enums for dispatch knobs (`"on" | "off" | "default"`)
 *      eliminate the {useStreaming?, disableStreaming?} mutex-pair
 *      problem at the type level — illegal states are unrepresentable
 *      in the parser's output.
 *   2. Validation is loud. `--timeout NaN`, repeated flag values, an
 *      unknown flag, or a missing-value flag throw at parse time with
 *      a message that names the offending token.
 *   3. The `--` separator marks the prompt boundary, so prompts may
 *      start with `--`. Anything before is parsed as flags; anything
 *      after is positional (the prompt).
 *
 * Returned shape:
 *
 *   {
 *     flags: ParsedFlags,    // typed, undefined-when-absent
 *     prompt: string,         // positionals joined with " "
 *     rest:   string[],       // positionals as-is (for callers that
 *                             // need argv-shape preservation)
 *     helpRequested: boolean  // true when --help was seen; callers
 *                             // should print formatHelp() and exit 0
 *   }
 */

/**
 * @typedef {"on" | "off" | "default"} TriState
 *
 * @typedef {object} ParsedFlags
 * @property {TriState}  [streaming]       // --streaming / --no-streaming
 * @property {TriState}  [facade]          // --facade / --no-facade
 * @property {string}    [wireLog]         // --wire-log <path>
 * @property {boolean}   [wireLogRaw]      // --wire-log-raw
 * @property {string}    [traceId]         // --trace-id <id>
 * @property {string}    [costLog]         // --cost-log <path>
 * @property {boolean}   [noCostLog]       // --no-cost-log (mutually exclusive with --cost-log)
 * @property {string}    [pricing]         // --pricing <path>
 * @property {string}    [facadeKey]       // --facade-key <token>
 * @property {number}    [timeoutMs]       // --timeout <ms>
 * @property {string}    [model]           // --model <id>
 * @property {string}    [cwd]             // --cwd <path>
 * @property {string}    [sessionId]       // --session <id> (resume)
 * @property {boolean}   [newSession]      // --new-session (fresh; mutex with --session)
 * @property {boolean}   [debug]           // --debug
 * @property {boolean}   [strictEnv]       // --strict-env
 *
 * @typedef {object} ParsedRunnerArgs
 * @property {ParsedFlags} flags
 * @property {string}      prompt
 * @property {string[]}    rest
 * @property {boolean}     helpRequested
 */

/**
 * Flags that take a single string value (next argv token).
 *
 * @type {ReadonlySet<string>}
 */
const STRING_FLAGS = new Set([
  "--wire-log",
  "--trace-id",
  "--cost-log",
  "--pricing",
  "--facade-key",
  "--model",
  "--cwd",
  "--session",
]);

/**
 * Tri-state flag triples: each entry maps a flag token to the
 * (target-field, value) pair to write on `flags`. Two distinct flags
 * setting the same target throw at parse time.
 *
 * @type {ReadonlyArray<{ flag: string, field: "streaming" | "facade", value: TriState }>}
 */
const TRI_STATE_FLAGS = [
  { flag: "--streaming", field: "streaming", value: "on" },
  { flag: "--no-streaming", field: "streaming", value: "off" },
  { flag: "--facade", field: "facade", value: "on" },
  { flag: "--no-facade", field: "facade", value: "off" },
];

/**
 * Parse a runner-script argv tail (i.e. `process.argv.slice(2)`).
 *
 * @param {string[]} argv
 * @returns {ParsedRunnerArgs}
 */
export function parseRunnerArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new TypeError("parseRunnerArgs: argv must be an array of strings");
  }

  /** @type {ParsedFlags} */
  const flags = {};
  /** @type {string[]} */
  const rest = [];
  let helpRequested = false;
  let separatorSeen = false;

  /** @type {Map<string, string>} Tracks which flag-token set each field, for conflict messages. */
  const setBy = new Map();

  function setTriState(field, value, token) {
    const prior = setBy.get(field);
    if (prior !== undefined && flags[field] !== value) {
      throw new Error(
        `Conflicting flags: \`${prior}\` and \`${token}\` both set \`${field}\``,
      );
    }
    /** @type {any} */ (flags)[field] = value;
    setBy.set(field, token);
  }

  function setString(field, token, value) {
    const prior = setBy.get(field);
    if (prior !== undefined) {
      throw new Error(`Flag \`${token}\` was already set by \`${prior}\``);
    }
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Flag \`${token}\` requires a non-empty value`);
    }
    /** @type {any} */ (flags)[field] = value;
    setBy.set(field, token);
  }

  function setBool(field, token) {
    if (setBy.get(field) !== undefined) {
      throw new Error(`Flag \`${token}\` was already set`);
    }
    /** @type {any} */ (flags)[field] = true;
    setBy.set(field, token);
  }

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (separatorSeen) {
      rest.push(arg);
      i += 1;
      continue;
    }

    if (arg === "--") {
      separatorSeen = true;
      i += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      helpRequested = true;
      i += 1;
      continue;
    }

    // Tri-state flags
    const tri = TRI_STATE_FLAGS.find((t) => t.flag === arg);
    if (tri) {
      setTriState(tri.field, tri.value, tri.flag);
      i += 1;
      continue;
    }

    // Boolean flags
    if (arg === "--wire-log-raw") {
      setBool("wireLogRaw", arg);
      i += 1;
      continue;
    }
    if (arg === "--no-cost-log") {
      setBool("noCostLog", arg);
      i += 1;
      continue;
    }
    if (arg === "--debug") {
      setBool("debug", arg);
      i += 1;
      continue;
    }
    if (arg === "--strict-env") {
      setBool("strictEnv", arg);
      i += 1;
      continue;
    }
    if (arg === "--new-session") {
      setBool("newSession", arg);
      i += 1;
      continue;
    }

    // Numeric flags
    if (arg === "--timeout") {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(
          "Flag `--timeout` requires a positive number of milliseconds",
        );
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
          `Flag \`--timeout\` requires a positive finite number; got \`${value}\``,
        );
      }
      if (setBy.get("timeoutMs") !== undefined) {
        throw new Error("Flag `--timeout` was already set");
      }
      flags.timeoutMs = parsed;
      setBy.set("timeoutMs", "--timeout");
      i += 2;
      continue;
    }

    // String-value flags
    if (STRING_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Flag \`${arg}\` requires a value`);
      }
      const field = stringFlagToField(arg);
      setString(field, arg, value);
      i += 2;
      continue;
    }

    // Anything starting with `--` past this point is an unknown flag.
    if (arg.startsWith("--") || (arg.startsWith("-") && arg.length > 1)) {
      throw new Error(
        `Unknown flag \`${arg}\` — use \`--\` to separate flags from prompt text starting with dashes`,
      );
    }

    // Plain positional
    rest.push(arg);
    i += 1;
  }

  // Cross-flag conflict checks that can't be expressed via setBy alone.
  if (flags.costLog !== undefined && flags.noCostLog) {
    throw new Error(
      "Conflicting flags: `--cost-log` and `--no-cost-log` are mutually exclusive",
    );
  }
  if (flags.sessionId !== undefined && flags.newSession) {
    throw new Error(
      "Conflicting flags: `--session <id>` and `--new-session` are mutually exclusive",
    );
  }

  return {
    flags,
    prompt: rest.join(" "),
    rest,
    helpRequested,
  };
}

/**
 * Map a string-value flag to its `ParsedFlags` field name.
 *
 * @param {string} token
 * @returns {string}
 */
function stringFlagToField(token) {
  switch (token) {
    case "--wire-log":
      return "wireLog";
    case "--trace-id":
      return "traceId";
    case "--cost-log":
      return "costLog";
    case "--pricing":
      return "pricing";
    case "--facade-key":
      return "facadeKey";
    case "--model":
      return "model";
    case "--cwd":
      return "cwd";
    case "--session":
      return "sessionId";
    default:
      throw new Error(`stringFlagToField: not a string flag \`${token}\``);
  }
}

/**
 * Produce human-readable usage text for `--help`. The caller's
 * `scriptName` is used to make the synopsis concrete (e.g.
 * `codex-prompt`).
 *
 * @param {string} scriptName
 * @returns {string}
 */
export function formatHelp(scriptName) {
  return `Usage: ${scriptName} [flags] [--] <prompt...>

Dispatch:
  --streaming           Route via streaming runner (warm path; default)
  --facade              Route via the daemon (artagon-openai-server)
  --no-facade           Force the in-process streaming path (skip daemon)

Observability:
  --wire-log <path>     Capture every JSON-RPC frame to <path>
  --wire-log-raw        Disable secret redaction in wire log
  --trace-id <id>       Correlation id for wire log + cost record

Cost recording:
  --cost-log <path>     Override cost.jsonl path
  --no-cost-log         Suppress cost recording for this invocation
  --pricing <path>      Override pricing table (JSON)

Facade:
  --facade-key <token>  Bearer token for the OpenAI facade

Per-turn:
  --timeout <ms>        Per-turn timeout (must be finite and > 0)
  --model <id>          Backend-specific model id or alias
  --cwd <path>          Working directory for the turn

Session (streaming runners only):
  --session <id>        Resume a prior session id (session/load or thread/resume)
  --new-session         Start a fresh session on the existing transport
                        (mutex with --session). Default reuses the cached session.

Diagnostics:
  --debug               Enable verbose diagnostics
  --strict-env          Throw on unknown ARTAGON_*/ACP_* env vars at boundary

Other:
  --help, -h            Print this message and exit
  --                    Mark the prompt boundary (use when prompt starts with dashes)

Examples:
  ${scriptName} Reply pong
  ${scriptName} --streaming Reply with the number 1
  ${scriptName} --streaming --wire-log /tmp/wire.jsonl --trace-id req-42 Reply hi
  ${scriptName} -- --this-is-the-prompt`;
}
