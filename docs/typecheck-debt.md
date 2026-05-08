# Type-check debt

**Current state: 0 errors.** Both `pnpm typecheck` (tsgo) and `pnpm typecheck:fallback` (stable tsc) pass cleanly against the source tree.

This file tracks JSDoc annotation work outstanding against the `checkJs: true` configuration in `tsconfig.json`. It is intentionally kept around (rather than deleted) so contributors who introduce new debt have a known place to record it.

## Configuration posture

`tsconfig.json` mirrors Codex's `tsconfig.app-server.json`:

```json
{
  "strict": false,
  "noImplicitAny": false,
  "useUnknownInCatchVariables": false
}
```

`checkJs` is a sanity gate, not a strict TypeScript port. Contributors should add JSDoc as documentation for public APIs and as type pins where downstream consumers rely on a specific shape (e.g., return types of exported helpers).

## Tests excluded from typecheck

`tests/**` is in `tsconfig.json::exclude`. Test files don't ship and adding strict types to test fixtures forces over-engineering test helpers. If a test file uncovers a real source-side typing gap, fix it on the source side; the test will then pick up the tightened type via inference.

## Adding new debt

If a code change introduces type errors that are non-trivial to fix in the same PR:

1. Record the file and a short description here under "Outstanding debt".
2. If the error is upstream-tooling-related (e.g., a tsgo limitation), cite the upstream issue.
3. Avoid silent `// @ts-expect-error` comments without explanation.

## Outstanding debt

(none — see "Current state" above)

## tsgo issues to track

(none recorded)
