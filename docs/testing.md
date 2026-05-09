# Testing

## Layers

| Layer       | Runner              | Where                             | Purpose                                                                                                                 |
| ----------- | ------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Unit        | vitest              | `tests/unit/**`                   | Pure-function and module-level checks; includes structural invariants like `cross-layer-redaction.test.mjs`             |
| Integration | vitest              | `tests/integration/**`            | Real fs, git, subprocess, broker socket fixtures                                                                        |
| Property    | vitest + fast-check | `tests/property/**`               | Fuzz JSON-RPC framing, message round-trips, wire-log redaction, redaction-middleware field-level redaction at any depth |
| Mutation    | stryker             | (no test files; mutates `lib/**`) | Score the suite's ability to catch real-world regressions                                                               |

## Commands

```sh
pnpm test                # vitest run (unit + integration + property)
pnpm test:watch          # vitest in watch mode
pnpm test:unit           # unit-only
pnpm test:int            # integration-only
pnpm test:property       # property-only
pnpm test:cov            # coverage report (v8)
pnpm test:mutation       # stryker (slow; nightly cron in CI)
```

## Property tests

`tests/property/jsonrpc-framing.test.mjs` — verifies the runtime's line-framed JSON-RPC parser:

- Random-shaped JSON-RPC messages survive `JSON.stringify → newline-frame → JSON.parse` round-trip
- Malformed lines are silently dropped (never throw)
- Empty / whitespace-only lines are ignored
- Mixed valid + malformed input preserves valid messages in order

`tests/property/message-roundtrip.test.mjs` — pins the ACP wire shape:

- Request, notification, response, and error envelopes round-trip cleanly
- Notifications never serialize an `id` field (server uses absence to distinguish from requests)
- Nested `session/prompt` params (with `prompt: [{ type, text }]` array) preserve structure

Property tests use `fc.jsonValue()` (not `fc.anything()`) for params — `JSON.stringify` converts `undefined` in arrays to `null`, which would create false counterexamples if `undefined` could appear.

## Mutation testing policy

Stryker runs nightly via `.github/workflows/mutation-testing.yml`. Current state:

- **Mutation surface:** `lib/**` (excluding `lib/test-utils/`). Plugin-internal code under `plugins/gemini/scripts/` is intentionally NOT mutated at the modernize-toolchain layer; it's an order of magnitude larger than `lib/` today and would explode runtime. As the architecture roadmap moves logic into `lib/`, the mutation surface tracks naturally.
- **Threshold:** `low: 70, high: 80, break: null`. The `null` break means a low-score run does NOT fail the workflow — we record score over time and promote to 70-as-blocking once a stable baseline exists.
- **Reports:** uploaded as a workflow artifact (`stryker-report`, retained 14 days). Open `reports/mutation/index.html` to inspect surviving mutants.

If a mutant survives that should die, the right fix is almost always a new test, not a stryker-config exclusion. Document any genuine survivors-by-design in `docs/mutation-debt.md`.

## When tests should be skipped

- `RUN_E2E=1` gates true end-to-end tests that hit external services. None exist today; reserved for future use.
- `MOCK_AUTH=fail` flips the ACP-mock binary to simulate an unauthenticated user (used by install integration tests).

## Running a single file or test

```sh
pnpm test tests/unit/feature-flags.test.mjs
pnpm test --t "getPluginVersion: empty env"
```

## Coverage

`pnpm test:cov` emits text + HTML + lcov reports under `coverage/`. Coverage is informational, not gating; mutation testing is the primary signal for "are these tests doing real work."
