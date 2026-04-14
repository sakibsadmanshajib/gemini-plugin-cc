/**
 * Lightweight argument parser for the gemini-companion CLI.
 * Mirrors the Codex plugin's args.mjs.
 */

/**
 * @typedef {{ options: Record<string, string | boolean>, positionals: string[] }} ParsedArgs
 */

/**
 * Parse argv-style arguments into options and positionals.
 *
 * @param {string[]} argv
 * @param {{ valueOptions?: string[], booleanOptions?: string[] }} schema
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, schema = {}) {
  const valueSet = new Set(schema.valueOptions ?? []);
  const booleanSet = new Set(schema.booleanOptions ?? []);
  /** @type {Record<string, string | boolean>} */
  const options = {};
  /** @type {string[]} */
  const positionals = [];
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const key = arg.slice(2);

      if (valueSet.has(key)) {
        i += 1;
        options[key] = argv[i] ?? "";
      } else if (booleanSet.has(key)) {
        options[key] = true;
      } else {
        // Unknown flags with a following value that doesn't look like a flag.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          options[key] = next;
          i += 1;
        } else {
          options[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }

    i += 1;
  }

  return { options, positionals };
}

/**
 * Split a raw CLI argument string (as passed by Claude Code's $ARGUMENTS) into
 * an argv-style array, respecting single and double quotes.
 *
 * @param {string} raw
 * @returns {string[]}
 */
export function splitRawArgumentString(raw) {
  if (!raw || typeof raw !== "string") {
    return [];
  }

  /** @type {string[]} */
  const tokens = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const ch of raw) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

/**
 * Convenience wrapper used by command handlers. Splits a raw argument string
 * and then parses it.
 *
 * @param {string[]} argv
 * @param {{ valueOptions?: string[], booleanOptions?: string[] }} schema
 * @returns {ParsedArgs}
 */
export function parseCommandInput(argv, schema = {}) {
  return parseArgs(argv, schema);
}
