---
description: Compare aggregate token usage against a budget; report remaining/exceeded.
---

Read the JSONL cost log under
`$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl` (or
`$ARTAGON_COST_LOG`) and compare aggregate token usage against a token
budget.

# Usage

```
/gemini:budget [--limit N | --limit-usd N] [--month] [--since ISO] [--until ISO] [--json]
```

# Budget resolution

Two modes, mutually exclusive:

**Token mode** (default):

1. `--limit N` flag
2. `$ARTAGON_BUDGET_TOKENS` env var
3. Default: 1,000,000 tokens

**USD mode** (when `--limit-usd N` or `$ARTAGON_BUDGET_USD` is set):

- Budget is denominated in dollars; gating uses estimated USD against
  the per-backend pricing table in `lib/cost/pricing.mjs`. Tokens are
  shown alongside as informational.

USD estimation uses default per-backend rates (Claude Sonnet, GPT-5,
Gemini 2.5 Pro). Override via `$ARTAGON_PRICING_OVERRIDE` (JSON).

# Window resolution

- `--since ISO` / `--until ISO` filter the records considered
- `--month` shorthand: `since` = first of the current calendar month (UTC)
- Default: count all-time

# Output

Token mode:

```
Budget (this month, 2026-05-01 →)
  Limit:    1,000,000 tokens
  Used:       124,000 (12.4%)
  Cost:        $1.86  (informational)
  Left:       876,000 tokens
  Status:   OK within budget
```

USD mode:

```
Budget (this month, 2026-05-01 →)
  Limit:        $5.00 (USD)
  Used:         $1.86 (37.2%)
  Tokens:    124,000  (informational)
  Left:         $3.14
  Status:   OK within budget
```

Exit code is always 0 — observability, not a hard ceiling. Downstream
tooling that wants gating can read `--json` (which includes both
token and USD totals).

# Implementation

The companion script is at `${CLAUDE_PLUGIN_ROOT}/scripts/budget.mjs`
and uses `summarizeCostRecords` from `#lib/cost/aggregate.mjs`.

`!node ${CLAUDE_PLUGIN_ROOT}/scripts/budget.mjs $ARGUMENTS`
