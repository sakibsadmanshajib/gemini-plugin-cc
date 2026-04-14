# Gemini Prompt Anti-Patterns

Common mistakes when composing prompts for Gemini tasks. Avoid these.

## Vague task framing

Bad:

```text
Look at the code and tell me what's wrong.
```

Better:

```xml
<task>
Investigate why `UserService.authenticate()` in `src/auth/service.ts:47` throws a null reference when the session cookie is expired.
Return: root cause, evidence, and smallest safe fix.
</task>
```

## Missing output contract

Bad:

```text
Investigate and report back.
```

Better:

```xml
<structured_output_contract>
Return:
1. root cause
2. evidence
3. smallest safe next step
</structured_output_contract>
```

## No follow-through default

Bad: Letting the model decide what to do when a step fails or when it hits missing context.

Better:

```xml
<default_follow_through_policy>
If a step fails, fix the failure and retry before moving on.
If the fix needs information you do not have, state what is missing and stop.
</default_follow_through_policy>
```

## Asking for more reasoning instead of a better contract

Bad: Increasing `--thinking-budget` when the model gives a bad answer.

Better: Tighten the output contract and provide more context. Thinking budget helps with complex multi-step reasoning, not with unclear instructions.

The model is not failing because it is not thinking hard enough. It is failing because the prompt does not tell it what "good" looks like.

## Mixing unrelated jobs into one run

Bad:

```text
Fix the auth bug, refactor the user model, and update the README.
```

Better: Three separate `gemini:rescue` runs, each with a single clear objective.

## Unsupported certainty

Bad: Treating Gemini's output as ground truth without verification.

Better: Always include a `<verification_loop>` block for tasks that change code, and validate the output against available tests and type checks.

When Gemini says "this is correct," it means "this is my best answer given the context." It does not mean "I have verified this against production."
