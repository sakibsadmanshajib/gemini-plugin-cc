# Mutation debt

Tracks Stryker mutants that survive by design — i.e., we've decided they're not worth a test. Every entry here is implicit acceptance of risk; favor adding a real test over adding an entry here.

## Process

1. Run `pnpm test:mutation` (or download the latest `stryker-report` artifact from the nightly CI workflow).
2. For each surviving mutant, ask: would a reasonable change in this region produce a real bug?
   - **Yes** → write the missing test. Don't add to this file.
   - **No** → record here with the file:line, the mutator name, and a one-sentence rationale.
3. If this file grows past ~20 entries, the mutation threshold is probably too tight. Re-evaluate the global config in `stryker.config.mjs`.

## Surviving mutants by design

(none recorded yet — populate after the first nightly cron run lands)

## Stryker bugs / quirks to track

(none recorded yet)
