# Spec Delta: feature-flags

## ADDED Requirements

### Requirement: Plugin version flag controls v2 behavior

The plugin SHALL read `ACP_PLUGIN_VERSION` from the environment at startup.
The flag's recognized values SHALL be `"v1"` and `"v2"`. The default value
SHALL be `"v1"`. All v2-specific behavior introduced by subsequent changes
MUST gate on `ACP_PLUGIN_VERSION === "v2"`.

#### Scenario: Default is v1

- **GIVEN** no `ACP_PLUGIN_VERSION` is set in the environment
- **WHEN** the plugin starts
- **THEN** `getPluginVersion()` returns `"v1"`
- **AND** all v1 behaviors apply
- **AND** no v2-only code paths execute

#### Scenario: Explicit v2 opt-in

- **GIVEN** `ACP_PLUGIN_VERSION=v2` is set
- **WHEN** the plugin starts
- **THEN** `getPluginVersion()` returns `"v2"`
- **AND** v2 behaviors apply for any feature that has shipped v2 paths

#### Scenario: Invalid value rejected

- **GIVEN** `ACP_PLUGIN_VERSION=experimental` is set
- **WHEN** the plugin starts
- **THEN** the plugin logs a warning that the value is unrecognized
- **AND** falls back to `"v1"` behavior
- **AND** does not crash

#### Scenario: Resolved value logged at debug

- **GIVEN** `ACP_LOG_LEVEL=debug` is set
- **WHEN** the plugin starts
- **THEN** the resolved plugin version is logged at debug level
- **AND** the log line includes the source (env var, default, fallback)

### Requirement: Flag plumbing must not introduce v2 behavior in this change

This change SHALL plumb the flag mechanism but SHALL NOT introduce any v2
behavior. The flag check SHALL exist; the v2 branches SHALL be empty
placeholders or absent.

#### Scenario: Flag set but no observable difference

- **GIVEN** the change `modernize-toolchain` is fully implemented
- **WHEN** the plugin runs with `ACP_PLUGIN_VERSION=v2`
- **THEN** plugin behavior is identical to running with `v1`
- **AND** the only observable difference is the debug log line
  reporting the resolved version

#### Scenario: Future v2 feature relies on flag

- **GIVEN** a future change introduces a v2 behavior
- **WHEN** that change ships
- **THEN** the v2 behavior is reachable only when
  `ACP_PLUGIN_VERSION=v2` is set
- **AND** the v1 behavior remains available unchanged when the flag is
  default

### Requirement: v1 baseline is anchored to a known commit

The "v1 behavior" referenced by `ACP_PLUGIN_VERSION=v1` SHALL be
defined as the runtime behavior of the plugin at the commit SHA
recorded in this change's `design.md`. The recorded SHA SHALL be the
last commit on `main` before this change's first PR merges. Any
divergence from that baseline introduced by subsequent v1-affecting
fixes SHALL be documented as a v1 amendment in the affecting change's
proposal.

#### Scenario: v1 baseline SHA recorded

- **GIVEN** this change is implemented
- **WHEN** the contributor inspects `design.md`
- **THEN** the design doc contains a section "v1 baseline" with the
  exact commit SHA used as the v1 reference

#### Scenario: v1 amendment documented

- **GIVEN** a future change introduces a v1-affecting bug fix
- **WHEN** that change's proposal is reviewed
- **THEN** the proposal explicitly notes the v1 amendment
- **AND** the v1 baseline doc is updated with a delta entry
