# State Schema

The plugin persists job state as JSON under a workspace-scoped directory. The on-disk format is versioned so future runtime changes can extend or modify the schema without breaking existing installs.

## Locations

The state-root directory is one of two paths, selected at runtime by host detection (see `gemini-plugin-baseline::Host Detection Contract`):

- **Claude Code host** — `$CLAUDE_PLUGIN_DATA/state/<slug>-<sha256-12hex>/`
- **Codex CLI host (fallback)** — `$TMPDIR/gemini-companion/<slug>-<sha256-12hex>/`

Per workspace tree the layout is:

```
<stateRoot>/<slug>-<hash>/
├── state.json              ← top-level config + job index
├── broker-session.json     ← broker liveness metadata
└── jobs/
    ├── <job-id>.json       ← full job record
    └── <job-id>.log        ← timestamped progress log
```

## v1 (current; written by legacy runtime)

```jsonc
{
  "version": 1,
  "config": {
    "stopReviewGate": false,
  },
  "jobs": [
    /* per-job records, capped at MAX_JOBS = 50, evicted by updatedAt */
  ],
}
```

The `version` field is the integer literal `1`. Read by `plugins/gemini/scripts/lib/state.mjs::loadState` at commit `f8f773c`.

## v2 (introduced by add-transport-abstraction-with-gemini)

```jsonc
{
  "schemaVersion": "2",
  "config": { "stopReviewGate": false },
  "jobs": [
    /* … */
  ],
}
```

The change from v1:

- `version: 1` → `schemaVersion: "2"` (string-typed, namespaced).
- All other v1 fields preserved verbatim. v1 → v2 is field-additive; no field is renamed or removed.

## Migration

`lib/state/migrate.mjs` exports:

- `detectSchemaVersion(state)` → `"v1" | "v2" | "unknown"` based on the field shape.
- `migrate(state)` → returns the latest schema. Idempotent on v2; throws on unknown.
- `defaultStateV2()` → canonical empty v2 state.

The migrator is **read-only at the v1/v2 transition**. The legacy runtime continues to read and write v1 unchanged. The v2 transport-abstraction runtime, when it lands as the production codepath (see `add-transport-abstraction-with-gemini` T7), will use `migrate()` on read so existing v1 files Just Work, and will write v2 thereafter.

A v1 file persisted by the legacy runtime alongside a v2 file written by a future runtime is fine — they live in the same directory, the migrator handles either on read.

## Adding a v3

A v3 schema requires:

1. A new explicit OpenSpec change describing the field-level diff.
2. Updates to `migrate.mjs`: `LATEST_SCHEMA_VERSION` bumped, a `migrateV2ToV3` helper added, `migrate(state)` chained to call it after `migrateV1ToV2`.
3. Tests verifying v1 → v3 and v2 → v3 round-trip.
4. If the change removes or renames a v2 field, an explicit deprecation cycle (one release with both fields written, then v3 stops writing the v2 field). Field-additive migrations don't need this — additive is the default.
