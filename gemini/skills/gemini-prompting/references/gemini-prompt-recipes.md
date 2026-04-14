# Gemini Prompt Recipes

Use these as starting templates for Gemini task prompts.
Copy the smallest recipe that fits the task, then trim anything you do not need.
In `gemini:gemini-rescue`, run diagnosis and fix-oriented recipes in write mode by default unless the user explicitly asked for read-only behavior.

## Diagnosis

```xml
<role>
You are Gemini performing root-cause diagnosis.
</role>

<task>
Investigate the described symptom. Identify the root cause with evidence.
Symptom: {{SYMPTOM}}
</task>

<structured_output_contract>
Return:
1. Root cause (one sentence)
2. Evidence (file paths, line numbers, observed behavior)
3. Confidence (high / medium / low with reasoning)
4. Smallest safe next step
</structured_output_contract>

<missing_context_gating>
If you need information that is not available, say so and stop.
Do not guess.
</missing_context_gating>

<verification_loop>
Re-read the evidence before finalizing. Confirm the root cause explains the symptom.
</verification_loop>
```

## Narrow Fix

```xml
<role>
You are Gemini applying a targeted code fix.
</role>

<task>
Fix the identified issue with the smallest correct change.
Issue: {{ISSUE}}
Root cause: {{ROOT_CAUSE}}
</task>

<constraints>
- Change only what is necessary to fix the issue.
- Do not refactor, rename, or clean up surrounding code.
- Preserve existing behavior for all paths not affected by the fix.
</constraints>

<completeness_contract>
Every file you create or modify must be syntactically valid and complete.
Do not leave TODO or placeholder comments.
</completeness_contract>

<verification_loop>
After applying the fix:
1. Re-read every changed file.
2. Run available tests.
3. Confirm the fix addresses the root cause without side effects.
</verification_loop>
```

## Root-Cause Review

```xml
<role>
You are Gemini reviewing code changes for correctness and risk.
</role>

<task>
Review the provided diff and supporting context.
Focus: {{FOCUS}}
</task>

<grounding_rules>
Every finding must be defensible from the provided context.
Do not invent scenarios you cannot support with evidence.
</grounding_rules>

<structured_output_contract>
Return only valid JSON matching the review output schema.
Keep findings ordered by severity.
</structured_output_contract>
```

## Research Or Recommendation

```xml
<role>
You are Gemini performing technical research.
</role>

<task>
Research the described topic and return actionable findings.
Topic: {{TOPIC}}
</task>

<research_mode>
Do not make code changes. Read, search, and analyze only.
</research_mode>

<structured_output_contract>
Return:
1. Observed facts (with sources)
2. Inferences (clearly marked)
3. Open questions
4. Recommended next step
</structured_output_contract>
```

## Prompt-Patching

```xml
<role>
You are Gemini improving a prompt for a downstream model or tool.
</role>

<task>
Analyze the provided prompt and improve it.
Original prompt: {{ORIGINAL_PROMPT}}
Observed failure: {{FAILURE}}
</task>

<structured_output_contract>
Return:
1. Diagnosis of why the original prompt failed
2. The improved prompt (complete, ready to use)
3. What changed and why
</structured_output_contract>

<constraints>
Do not change the intent of the original prompt.
Focus on clarity, specificity, and output contract quality.
</constraints>
```
