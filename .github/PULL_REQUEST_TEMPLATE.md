<!--
Thanks for contributing to artagon-agent-cli-plugin!

Before opening: run `pnpm typecheck && pnpm exec biome check . && pnpm test`
locally. CI runs the same gates plus install/SBOM checks.
-->

## Summary

<!-- 1–3 bullets on what this PR changes and why. Focus on the "why";
     the "what" is in the diff. -->

-
-

## Type of change

<!-- Check all that apply. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that would cause existing
      functionality not to work as expected)
- [ ] Documentation only
- [ ] Refactor / dev-experience / test infrastructure
- [ ] Dependency update / security patch
- [ ] CI / release tooling

## Test plan

<!-- What did you do to verify the change? Mark each box and add a
     short note. -->

- [ ] `pnpm typecheck` — 0 errors
- [ ] `pnpm exec biome check .` — clean
- [ ] `pnpm test` — all green
- [ ] Manual smoke test (describe what you ran, against which backend)
- [ ] Updated docs (CHANGELOG, README, docs/\* as appropriate)
- [ ] Updated tests for new code paths

## Backwards compatibility

<!-- If this is a breaking change, describe the migration path. If
     not, write "No breaking changes." -->

## Backend coverage

<!-- For runner / facade / plugin changes, which backends were
     exercised? -->

- [ ] Claude (`runClaudePrint`)
- [ ] Codex (`runCodexExec`)
- [ ] Gemini (`runGeminiPrint`)
- [ ] OpenAI facade (`/v1/chat/completions`, `/v1/models`, `/health`)
- [ ] N/A — change does not touch backend runners

## Related issues

<!-- Link to issues this PR closes or is part of. Use "Closes #123" so
     GitHub auto-closes on merge. -->

Closes #

## Screenshots / output

<!-- Optional. Paste relevant CLI output, error traces, or screenshots
     from the OpenAI facade. -->
