---
name: gemini-prompting
description: Gemini model prompting guide for effective task delegation from Claude Code
user-invocable: false
---

# Gemini Prompting Guide

## When to Use

Use this skill only to shape the prompt text before forwarding it to the `gemini-companion` runtime. Do not use it to do independent work, inspect the repository, or draft solutions.

## Gemini Model Characteristics

- **Long context**: Gemini models handle up to 1M tokens of context. Lean into providing full file contents rather than snippets.
- **System instructions**: Gemini's primary steering mechanism. Place behavioral constraints, output format requirements, and role definitions in system instruction blocks.
- **Thinking**: Gemini models support configurable thinking budgets. Use `--thinking-budget` for complex reasoning tasks.
- **Grounding**: Gemini can use Google Search for grounding. For tasks requiring up-to-date information, mention this in the prompt.
- **Structured output**: Request JSON output by describing the schema in the prompt. Gemini follows schema instructions well when given clear examples.

## Prompt Structure

Use XML tags to structure prompts for clarity:

```xml
<role>
Define the persona and operating stance.
</role>

<task>
State what needs to be done. Be specific about inputs and expected outputs.
</task>

<context>
Provide repository context, file contents, error messages, or other relevant information.
</context>

<constraints>
List hard boundaries: what NOT to do, scope limits, safety rules.
</constraints>

<output_contract>
Define the exact output shape. Use JSON schema descriptions or examples.
</output_contract>
```

## Key Principles

1. **Be specific, not vague**: "Fix the null pointer in `auth.go:142`" beats "Fix the bug".
2. **Include output contracts**: Always specify what the response should look like.
3. **Provide full context**: Gemini handles long context well — give it complete files, not snippets.
4. **Use system instructions for behavior**: Role, tone, constraints go in system instruction blocks.
5. **One task per prompt**: Don't mix unrelated jobs. Split into separate runs.
6. **Include verification steps**: Ask Gemini to verify its own work before finalizing.

## References

- [Prompt Blocks](references/prompt-blocks.md) — Reusable XML blocks for common patterns
- [Gemini Prompt Recipes](references/gemini-prompt-recipes.md) — End-to-end templates for diagnosis, fixes, reviews, research
- [Gemini Prompt Anti-Patterns](references/gemini-prompt-antipatterns.md) — Common mistakes to avoid
