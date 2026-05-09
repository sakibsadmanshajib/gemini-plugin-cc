/**
 * Backend model discovery.
 *
 * Aggregates the declared `modelAliases` from each backend declaration
 * into a uniform list of `{id, backend, owned_by}` records suitable for
 * the OpenAI `/v1/models` endpoint shape.
 *
 * Source-of-truth: each backend's `modelAliases` (Maps in
 * `lib/backends/{gemini,codex,claude}.mjs`). These are populated from
 * the documented model lists per backend (each backend's CLI itself
 * doesn't expose a standard model-list ACP method today; ACP's
 * `initialize` returns `authMethods` and `agentCapabilities` but not
 * model enumeration).
 *
 * Models that are bare aliases (e.g. `claude-sonnet-4-6` mapping to
 * itself) appear once in the output. Models that have multiple aliases
 * (e.g. `sonnet` → `claude-sonnet-4-6`) show all alias forms but
 * deduplicate by canonical id, so the output looks like:
 *
 *   { id: "claude-sonnet-4-6", aliases: ["sonnet"], backend: "claude", ... }
 *
 * The default model per backend is flagged via `is_default: true`.
 *
 * Why not call the CLI to enumerate? The CLIs' authoritative answer is
 * "whatever your account/auth grants access to" — that requires
 * authenticated network calls (gemini's auth probe + a model-list API,
 * codex's `/v1/models` against api.openai.com, claude's `/v1/models`
 * against api.anthropic.com). Doing that on every `/v1/models` request
 * would be slow + flaky. Instead, the declared aliases are static + can
 * be regenerated as upstream model catalogs evolve.
 */

import { claudeBackend } from "#lib/backends/claude.mjs";
import { codexBackend } from "#lib/backends/codex.mjs";
import { geminiBackend } from "#lib/backends/gemini.mjs";
import { ALL_BACKEND_NAMES, BACKEND_NAMES } from "#lib/backends/names.mjs";

/**
 * @typedef {{
 *   id: string,
 *   backend: import("#lib/backends/names.mjs").BackendName,
 *   aliases: string[],
 *   is_default: boolean,
 *   owned_by: string
 * }} BackendModel
 */

/** @type {Record<string, { aliases: ReadonlyMap<string, string>, defaultModel: string }>} */
const BACKEND_DECLARATIONS = {
  [BACKEND_NAMES.CLAUDE]: {
    aliases: claudeBackend.modelAliases,
    defaultModel: claudeBackend.defaultModel
  },
  [BACKEND_NAMES.CODEX]: {
    aliases: codexBackend.modelAliases,
    defaultModel: codexBackend.defaultModel
  },
  [BACKEND_NAMES.GEMINI]: {
    aliases: geminiBackend.modelAliases,
    defaultModel: geminiBackend.defaultModel
  }
};

/**
 * Map a backend name to its npm-package "owned_by" label for the
 * OpenAI models response.
 *
 * @param {import("#lib/backends/names.mjs").BackendName} backend
 * @returns {string}
 */
function ownedByFor(backend) {
  return `artagon-agent-cli-plugin (${backend})`;
}

/**
 * Discover all models for one backend.
 *
 * @param {import("#lib/backends/names.mjs").BackendName} backend
 * @returns {BackendModel[]}
 */
export function getBackendModels(backend) {
  const decl = BACKEND_DECLARATIONS[backend];
  if (!decl) return [];

  // Group aliases by their canonical (resolved) id.
  /** @type {Map<string, string[]>} */
  const aliasesByCanonical = new Map();
  for (const [alias, canonical] of decl.aliases) {
    if (alias === canonical) {
      // Self-mapping — make sure the canonical entry exists even if no
      // other alias points at it.
      if (!aliasesByCanonical.has(canonical)) {
        aliasesByCanonical.set(canonical, []);
      }
    } else {
      const existing = aliasesByCanonical.get(canonical) ?? [];
      existing.push(alias);
      aliasesByCanonical.set(canonical, existing);
    }
  }

  // Resolve the default model's canonical id (the alias might point
  // somewhere else).
  const defaultCanonical = decl.aliases.get(decl.defaultModel) ?? decl.defaultModel;

  /** @type {BackendModel[]} */
  const out = [];
  for (const [id, aliases] of aliasesByCanonical) {
    out.push({
      id,
      backend,
      aliases: [...aliases].sort(),
      is_default: id === defaultCanonical,
      owned_by: ownedByFor(backend)
    });
  }

  // Sort: default first, then alphabetical by id.
  out.sort((a, b) => {
    if (a.is_default !== b.is_default) return a.is_default ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return out;
}

/**
 * Discover models for all known backends.
 *
 * @returns {BackendModel[]}
 */
export function getAllBackendModels() {
  /** @type {BackendModel[]} */
  const out = [];
  for (const backend of ALL_BACKEND_NAMES) {
    out.push(...getBackendModels(backend));
  }
  return out;
}

/**
 * Translate a discovered model to the OpenAI `/v1/models` entry shape.
 *
 *   { id, object: "model", created, owned_by }
 *
 * Per OpenAI convention, `id` is what the client uses in subsequent
 * `model:` fields. We expose BOTH the canonical id (`claude-sonnet-4-6`)
 * AND each alias (`sonnet`) as separate entries so a client can use
 * either form.
 *
 * @param {BackendModel} model
 * @returns {Array<{ id: string, object: "model", created: number, owned_by: string }>}
 */
export function toOpenAiModelEntries(model) {
  const created = 0; // We don't track creation dates upstream.
  /** @type {Array<{ id: string, object: "model", created: number, owned_by: string }>} */
  const entries = [{ id: model.id, object: "model", created, owned_by: model.owned_by }];
  for (const alias of model.aliases) {
    entries.push({
      id: alias,
      object: "model",
      created,
      owned_by: model.owned_by
    });
  }
  return entries;
}
