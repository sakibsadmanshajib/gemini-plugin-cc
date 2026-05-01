# Spec Delta: feature-flags (modified)

This change MODIFIES the `feature-flags` capability introduced in
`modernize-toolchain`. The default value of `ACP_PLUGIN_VERSION`
flips from `v1` to `v2`.

## MODIFIED Requirements

### Requirement: Plugin version flag controls v2 behavior

The plugin SHALL read `ACP_PLUGIN_VERSION` from the environment at
startup. The flag's recognized values SHALL be `"v1"` and `"v2"`. **The
default value SHALL be `"v2"`.** Users who require v1 behavior SHALL
explicitly set `ACP_PLUGIN_VERSION=v1` for the 30-day deprecation
window after this change archives.

#### Scenario: Default is v2

- **GIVEN** no `ACP_PLUGIN_VERSION` is set in the environment
- **WHEN** the plugin starts
- **THEN** `getPluginVersion()` returns `"v2"`
- **AND** v2 behaviors apply (multi-plugin layout, all backends
  available)

#### Scenario: Explicit v1 opt-in within deprecation window

- **GIVEN** the user sets `ACP_PLUGIN_VERSION=v1`
- **AND** the current date is within 30 days of the v2 default flip
- **WHEN** the plugin starts
- **THEN** `getPluginVersion()` returns `"v1"`
- **AND** v1 behavior applies (single-Gemini-plugin layout)
- **AND** a one-time-per-session deprecation warning is emitted
  pointing to `docs/v1-deprecation.md`

#### Scenario: Explicit v1 opt-in after deprecation window

- **GIVEN** the user sets `ACP_PLUGIN_VERSION=v1`
- **AND** the current date is past the documented v1 removal date
- **WHEN** the plugin starts
- **THEN** the plugin logs a warning that v1 has been removed
- **AND** falls back to v2 behavior

#### Scenario: Invalid value rejected (unchanged)

- **GIVEN** `ACP_PLUGIN_VERSION=experimental` is set
- **WHEN** the plugin starts
- **THEN** the plugin logs a warning that the value is unrecognized
- **AND** falls back to the current default (`"v2"` after this change)
- **AND** does not crash

### Requirement: Flag plumbing must not introduce v2 behavior in this change

This requirement SHALL be considered SUPERSEDED by the present change: v2 behavior is now the default, so the prior constraint that flag plumbing must not introduce v2 behavior no longer applies.

#### Scenario: Superseded requirement is no longer enforced

- **GIVEN** this change has archived
- **WHEN** new code introduces v2 behavior gated by `ACP_PLUGIN_VERSION`
- **THEN** the introduction is permitted under the updated default
- **AND** no v1-only enforcement remains
