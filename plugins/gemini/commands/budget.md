---
description: Compare aggregate token usage against a budget; report remaining/exceeded.
---

Read the JSONL cost log under
`$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl` (or
`$ARTAGON_COST_LOG`) and compare aggregate token usage against a token
budget.

# Usage

```
/gemini:budget [--limit N] [--month] [--since ISO] [--until ISO] [--json]
```

# Budget resolution

In order of precedence:

1. `--limit N` flag
2. `$ARTAGON_BUDGET_TOKENS` env var
3. Default: 1,000,000 tokens

# Window resolution

- `--since ISO` / `--until ISO` filter the records considered
- `--month` shorthand: `since` = first of the current calendar month (UTC)
- Default: count all-time

# Output

```
Budget (this month, 2026-05-01 →)
  Limit:    1,000,000 tokens
  Used:       124,000 (12.4%)
  Left:       876,000
  Status:   OK within budget
```

Exit code is always 0 — observability, not a hard ceiling. Downstream
tooling that wants gating can read `--json`.

# Implementation

The companion script is at `${CLAUDE_PLUGIN_ROOT}/scripts/budget.mjs`
and uses `summarizeCostRecords` from `#lib/cost/aggregate.mjs`.

`!node ${CLAUDE_PLUGIN_ROOT}/scripts/budget.mjs $ARGUMENTS`
