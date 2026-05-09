# Feature flags

## `ACP_PLUGIN_VERSION`

Selects the plugin's behavior generation. The flag is plumbed through `lib/feature-flags.mjs::getPluginVersion()` and consumed by code paths added in post-`modernize-toolchain` changes.

**Values:**

- `v1` (default) — Current behavior captured by the `gemini-plugin-baseline` capability at commit `f8f773c`. Includes everything the plugin does today: ACP broker, `gemini --acp` spawn pattern, flat `--json` shapes, `session/{new,load,prompt,cancel}` wire surface, etc.
- `v2` — Opt-in behavior introduced by subsequent changes. Initially nothing differs; specific v2-gated changes will document their behavior here as they land. Examples (anticipated, not yet implemented):
  - `add-transport-abstraction-with-gemini`: routes through `lib/transport/cli.mjs` instead of direct `acp-broker.mjs`.
  - `align-gemini-plugin-cli-schema-with-codex`: emits nested `--json` shape with `schemaVersion: "v1"` field.
  - `add-app-server-transport-and-marketplace-split`: alternative App Server transport for backends that support it.

**Current status (post-rebrand):** the flag is plumbed at
`lib/feature-flags.mjs::getPluginVersion` but no caller branches
on the result yet — the only consumer at
`plugins/gemini/scripts/gemini-companion.mjs` reads the value
purely to log it under `DEBUG=1`. The multi-backend behavior (the
original v2 design intent) shipped via the
`artagon-agent-cli-plugin` rebrand without going through the
flag-gated cutover this doc describes. The flag's lifecycle is
preserved for future opt-in toggles that genuinely need an
env-controlled switch — see `openspec/glossary.md`'s
`ACP_PLUGIN_VERSION` entry for the longer treatment.

## Resolution

```sh
ACP_PLUGIN_VERSION=v2 node plugins/gemini/scripts/gemini-companion.mjs setup --json
```

- Unset / empty → `v1`.
- Unknown value → falls back to `v1` with a one-shot stderr warning (`[feature-flags] Unknown ACP_PLUGIN_VERSION=...; falling back to v1.`).
- `DEBUG=1` → companion's `main()` logs the resolved version on entry as `[debug] ACP_PLUGIN_VERSION=<version>`.

## Lifecycle

- Each v2-introducing change MUST cite this file and add a one-line entry to the v2 list above describing the gated behavior.
- A v2 → default-on promotion is its own breaking change with its own OpenSpec proposal; the flag does not auto-flip.
- v3 (when needed) extends the union in `lib/feature-flags.mjs::PluginVersion`; do NOT silently add new values to the env-parser without updating `VALID_VERSIONS`.

## Why a flag and not a major-version bump

The plugin is shipped via marketplaces (Claude Code, Codex CLI). A user-facing major-version bump forces all consumers to migrate at once. A runtime flag lets early adopters opt into v2 while the default-on cohort stays on v1; the eventual promotion is a coordinated cut, not an ambient surprise.
