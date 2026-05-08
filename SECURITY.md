# Security Policy

We take the security of the Artagon Agent CLI Plugin suite seriously,
including its three plugins (Claude Code, Codex CLI, Gemini host),
the OpenAI HTTP facade, and the cost-recording infrastructure.

## Reporting a Vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Use one of these channels instead, in order of preference:

1. **GitHub Private Security Advisory** (preferred):
   <https://github.com/artagon/artagon-agent-cli-plugin/security/advisories/new>

2. **Email**: `security@artagon.dev`
   PGP key fingerprint forthcoming; encrypt sensitive details only if
   you have a verified key. Plain email is acceptable for non-critical
   reports.

We aim to acknowledge a report within **3 business days** and provide
an initial assessment within **7 business days**. Critical findings
get faster turnaround.

## What to Include

- A clear description of the vulnerability + impact (read access?
  write access? remote code execution? local privilege escalation?)
- Reproduction steps or proof-of-concept (a minimal one is fine).
- Affected version(s) — commit SHA preferred over tag if known.
- Whether you've found this issue elsewhere or if it has a CVE.
- Whether you intend to publicly disclose, and on what timeline.

We follow **coordinated disclosure**: we'd prefer a private window to
fix and ship before public details land. The default window is 90
days from acknowledgement; we can negotiate shorter or longer based
on severity and your needs.

## Supported Versions

We patch security issues on:

- The current `main` branch
- The latest published release on npm (`artagon-agent-cli-plugin`)
- Any release < 6 months old where patching is practical

Older releases are best-effort. If you're running an older version
and a vulnerability is reported, we recommend upgrading rather than
backporting.

## Scope

In scope:

- Code in this repository (`lib/`, `bin/`, `plugins/`, workflows,
  tests).
- The published npm package and its supply chain (provenance, SBOM,
  install scripts).
- The cost-record persistence layer (file permissions, log path
  resolution, env var handling).
- The OpenAI HTTP facade (`/v1/chat/completions`, `/v1/models`,
  `/health`).

Out of scope (for this project — report upstream):

- Bugs in the underlying vendor CLIs (`claude`, `codex`, `gemini`).
  Those CLIs are external dependencies; we shell out to them.
- Bugs in transitive npm dependencies — please report to the upstream
  package maintainer first. We'll mirror upstream advisories via
  Dependabot once disclosed.

## Hardening Already in Place

Reviewable in the codebase:

- **CodeQL javascript-typescript scan** runs on every PR + weekly
  schedule (`.github/workflows/codeql.yml`).
- **GitHub Actions pinned to commit SHAs** (40-char) — defense
  against tag-replacement supply-chain attacks
  (`.github/workflows/*.yml`).
- **npm publish via OIDC + Sigstore** — provenance attestation on
  every release (`.github/workflows/npm-publish.yml`).
- **CycloneDX SBOM** (JSON + XML) attached as a release artifact;
  generator pinned via `pnpm-lock.yaml` integrity SHA-512 (not
  `npx <pkg>` which would resolve fresh).
- **Crypto-strong randomness** for session IDs and chat-completion
  IDs (`crypto.randomBytes`, never `Math.random`) — enforced by
  CodeQL `js/insecure-randomness`.
- **Cost record write mode 0o600** — owner-only read/write.
- **No stack-trace exposure** in HTTP facade error responses;
  detail goes to stderr (`js/stack-trace-exposure`).
- **PID-reuse hardening** in the orphan-runner reaper — captures
  OS-reported start time at register; refuses to SIGKILL on PID
  recycle (`lib/runners/orphan-check.mjs`).
- **Audit log** is append-only JSONL keyed by cryptographically
  random session ID, default mode 0o600
  (`~/.acp-plugins/audit/<session>/audit.jsonl`).

## Acknowledgements

We'll credit reporters in release notes (with permission). If you'd
like to remain anonymous, just say so.
