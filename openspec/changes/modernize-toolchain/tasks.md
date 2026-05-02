# Tasks: modernize-toolchain

## 1. pnpm migration

- [ ] T1.1 — Add `pnpm-workspace.yaml` with empty `packages:` list (placeholder)
- [ ] T1.2 — Add `engines.pnpm` and `engines.node` to root `package.json`
- [ ] T1.3 — Run `pnpm import` to convert `package-lock.json` → `pnpm-lock.yaml`
- [ ] T1.4 — Add `package-lock.json` to `.gitignore` (deletion happens in T1.5)
- [ ] T1.5 — Delete `package-lock.json` in dedicated commit
- [ ] T1.6 — Update CI to use `pnpm/action-setup@v4` and `cache: 'pnpm'`
- [ ] T1.7 — README install section: `pnpm install` instead of `npm install`,
  with note for contributors on installing pnpm via corepack

## 2. Type checking via tsgo + JSDoc

- [ ] T2.1 — Install `@typescript/native-preview` as devDependency
- [ ] T2.2 — Create `tsconfig.json` with `allowJs: true`, `checkJs: true`,
  `strict: true`, `noEmit: true`, `moduleResolution: "node16"`,
  `target: "es2023"`, `module: "node16"`
- [ ] T2.3 — Add `pnpm typecheck` script invoking `tsgo --noEmit`
- [ ] T2.4 — Add ambient type stub for ACP message shapes in `types/acp.d.ts`
- [ ] T2.5 — Annotate `acp-broker.mjs`, `acp-client.mjs`, `gemini-companion.mjs`
  with JSDoc; resolve type errors. Document remaining issues in
  `docs/typecheck-debt.md` if any
- [ ] T2.6 — Add weekly CI cron job that runs typecheck under stable tsc as
  fallback validator (tsgo regression detection)

## 3. Lint and format via Biome

- [ ] T3.1 — Install `@biomejs/biome` as devDependency
- [ ] T3.2 — Create `biome.json` with includes for `**/*.{mjs,js,json}`,
  recommended rules enabled, formatter enabled with 2-space indent
- [ ] T3.3 — Run `biome check --apply` in dedicated commit
- [ ] T3.4 — Add commit SHA to `.git-blame-ignore-revs`
- [ ] T3.5 — Add `pnpm lint` and `pnpm format` scripts
- [ ] T3.6 — Add `editorconfig` aligned with Biome settings

## 4. Pre-commit hooks via husky

- [ ] T4.1 — Install `husky` as devDependency
- [ ] T4.2 — Run `husky init` to create `.husky/` directory
- [ ] T4.3 — Add `.husky/pre-commit` running `pnpm exec biome check --staged`
- [ ] T4.4 — Test on a branch: stage an unformatted file, commit, verify
  formatter runs and re-stages

## 5. Feature flag scaffolding

- [ ] T5.1 — Create `lib/feature-flags.mjs` exporting `getPluginVersion()`
  reading `ACP_PLUGIN_VERSION` env var, defaulting to `"v1"`
- [ ] T5.2 — Document flag semantics in `docs/feature-flags.md`:
  - `v1` = current behavior, all defaults
  - `v2` = opt-in behavior introduced by subsequent changes
- [ ] T5.3 — Add `getPluginVersion()` call site in `gemini-companion.mjs`
  bootstrap; log resolved version at debug level
- [ ] T5.4 — No v2 behavior shipped in this proposal; flag is plumbed but
  inert until later changes use it

## 6. CI integration

- [ ] T6.1 — Update `.github/workflows/ci.yml`: install pnpm, run
  `pnpm install --frozen-lockfile`, then `pnpm lint && pnpm typecheck && pnpm test`
- [ ] T6.2 — Add matrix on Node 18.18, 20, 22; OS Linux, macOS
- [ ] T6.3 — Add separate `tsgo-fallback.yml` weekly cron job using stable tsc
- [ ] T6.4 — Cache pnpm store across runs for speed

## 7. Verification and rollback test

- [ ] T7.1 — All pre-existing tests pass under new toolchain
- [ ] T7.2 — Add `tests/e2e/toolchain-lifecycle.test.mjs` covering:
  install → lint → typecheck → test → revert → npm-fallback works
- [ ] T7.3 — Manual verification: install plugin from feature branch via
  `claude plugin install`, run `/gemini:setup`, confirm no regression
- [ ] T7.4 — README has migration instructions for contributors

## 8. Documentation

- [ ] T8.1 — `docs/contributing.md` updated for pnpm + Biome workflow
- [ ] T8.2 — `docs/feature-flags.md` created
- [ ] T8.3 — `docs/typecheck-debt.md` created (may be empty if no debt)
- [ ] T8.4 — README badges updated (CI, version)

## Acceptance

- [ ] All tasks above checked
- [ ] CI green for 7 consecutive days on the feature branch
- [ ] At least 2 PRs reviewed by Codex via `/codex:adversarial-review`,
  reviews committed under `reviews/codex/`
- [ ] No `console.log` introduced (Biome rule enforces; spec asserts)
- [ ] `pnpm install && pnpm check` succeeds on clean checkout
- [ ] Rollback procedure documented and tested in T7.2
