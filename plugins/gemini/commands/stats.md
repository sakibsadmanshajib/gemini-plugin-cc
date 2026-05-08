---
description: Show aggregate cost statistics from the local cost-record log (per-backend turns, tokens, wall-clock).
---

Read the JSONL cost log under
`$XDG_STATE_HOME/artagon-agent-cli-plugin/cost.jsonl` (or
`$ARTAGON_COST_LOG`) and print a summary of recorded turns.

# Usage

```
/gemini:stats [--json] [--recent N] [--since ISO] [--until ISO]
```

By default, prints the global summary plus the 5 most recent turns.

# Behavior

- Loads all cost records from the local log
- Aggregates per backend (claude, codex, gemini)
- Reports totals: turns, tokens, wall-clock, time window
- `--json` emits the full summary + recent list as JSON
- `--recent 0` suppresses the recent list

# Implementation

The companion script is at `${CLAUDE_PLUGIN_ROOT}/scripts/stats.mjs`
and uses `summarizeCostRecords` / `recentCostRecords` from
`#lib/cost/aggregate.mjs`. No backend invocation; pure log read.

`!node ${CLAUDE_PLUGIN_ROOT}/scripts/stats.mjs $ARGUMENTS`
