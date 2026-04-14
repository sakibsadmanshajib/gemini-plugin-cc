# Prompt Blocks

Reusable XML blocks for composing Gemini prompts. Copy the smallest set that fits the task.

## Core Wrapper

### `task`

```xml
<task>
State the objective in one sentence.
Follow with any necessary sub-goals.
End with the single measurable outcome that signals "done."
</task>
```

## Output and Format

### `structured_output_contract`

Use when the response shape matters.

```xml
<structured_output_contract>
Return exactly the requested output shape and nothing else.
Keep the answer compact.
Put the highest-value findings or decisions first.
</structured_output_contract>
```

### `compact_output_contract`

Use when brevity matters more than structure.

```xml
<compact_output_contract>
Return a compact final answer.
No preamble or recap.
</compact_output_contract>
```

## Follow-through and Completion

### `default_follow_through_policy`

```xml
<default_follow_through_policy>
If a step fails, fix the failure and retry before moving on.
If the fix needs information you do not have, state what is missing and stop.
Do not skip ahead when a prior step is incomplete.
</default_follow_through_policy>
```

### `completeness_contract`

```xml
<completeness_contract>
Every file you create or modify must be syntactically valid and complete.
Do not leave TODO, FIXME, or placeholder comments in shipped code.
If a piece of work is too large to finish, say so and stop at a clean boundary.
</completeness_contract>
```

### `verification_loop`

```xml
<verification_loop>
After completing the main task:
1. Re-read every file you changed.
2. Run any available tests or type checks.
3. Confirm the change does what the task asked for.
4. If something is wrong, fix it before reporting done.
</verification_loop>
```

## Grounding and Missing Context

### `missing_context_gating`

```xml
<missing_context_gating>
If you need information that is not available in the provided context or tool outputs, say so explicitly and stop.
Do not guess, hallucinate file contents, or assume behavior you cannot verify.
</missing_context_gating>
```

### `grounding_rules`

```xml
<grounding_rules>
Every claim must be defensible from the provided context or tool outputs.
Do not invent files, lines, code paths, or runtime behavior you cannot support.
If a conclusion depends on an inference, state that explicitly.
</grounding_rules>
```

### `citation_rules`

```xml
<citation_rules>
When referencing code, include the file path and line number.
When referencing documentation, include the source.
Do not make claims without traceable evidence.
</citation_rules>
```

## Safety and Scope

### `action_safety`

```xml
<action_safety>
Do not delete files, drop tables, kill processes, or run destructive commands without explicit instruction.
Prefer reversible actions over irreversible ones.
When in doubt, report what you would do and ask for confirmation.
</action_safety>
```

### `tool_persistence_rules`

```xml
<tool_persistence_rules>
Do not install global packages, modify shell profiles, or change system configuration.
Limit side effects to the working directory unless explicitly instructed otherwise.
</tool_persistence_rules>
```

## Task-Specific Blocks

### `research_mode`

```xml
<research_mode>
This is a research task. Do not make code changes.
Read, search, and analyze. Return findings only.
Organize findings as: observed facts, inferences, open questions.
</research_mode>
```

### `dig_deeper_nudge`

```xml
<dig_deeper_nudge>
Before finalizing, check for second-order failures, empty-state behavior, retries, stale state, rollback risk, and design tradeoffs.
</dig_deeper_nudge>
```

### `progress_updates`

```xml
<progress_updates>
After each major step, emit a one-line progress update to stderr.
Format: [step N/M] description
</progress_updates>
```
