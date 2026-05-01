# Spec Delta: state-schema

## ADDED Requirements

### Requirement: Job state files are versioned

Job state files persisted by the plugin SHALL include a top-level
`schemaVersion` field. The current schema version SHALL be `"2"` (v2 of
the plugin's state format). Reader code SHALL accept files with
`schemaVersion: "1"` and migrate them in-memory to v2 shape; v1 readers
SHALL ignore unknown fields (additive evolution).

#### Scenario: v2 reads v1 file

- **GIVEN** a job state file written by an earlier version with
  `schemaVersion: "1"` (or no `schemaVersion` field, treated as 1)
- **WHEN** v2 plugin code reads the file
- **THEN** the reader migrates the in-memory representation to v2 shape
- **AND** persists v2-shaped data on next write
- **AND** the file is not corrupted by partial reads

#### Scenario: v1 ignores v2-only fields

- **GIVEN** a job state file written by v2 code with extra fields
  (e.g., `transportKind: "sdk"`)
- **WHEN** v1 plugin code (during the deprecation window) reads the file
- **THEN** v1 ignores unknown fields
- **AND** preserves them on rewrite (round-trip safe)

#### Scenario: Schema migration tested

- **GIVEN** the state-schema test suite
- **WHEN** the suite runs
- **THEN** for each known prior schema version, a fixture file is
  provided
- **AND** the migration succeeds
- **AND** the migrated structure passes schema validation

### Requirement: Schema changes are documented

A future change that bumps the schema version SHALL document the change in its `design.md`, including:
- the new fields added
- the migration from prior version
- whether prior versions remain readable

#### Scenario: Schema version bump documented

- **GIVEN** a future change introducing `schemaVersion: "3"`
- **WHEN** the change's design doc is reviewed
- **THEN** the doc lists added fields and their semantics
- **AND** describes the v2 → v3 migration
- **AND** states forward-compatibility (whether v2 can still read v3
  files, treating new fields as ignored)
