# Review Round 2 — Adversarial Engineer

**Reviewer lens**: technical attacks, race conditions, error paths,
concurrency hazards, "what breaks under load."

**Method**: read each spec assuming hostile inputs, hardware failures,
network partitions, malicious users, racing subprocesses. Find attack
vectors and design weaknesses.

---

## Cross-cutting findings

### B-1: Subprocess inheritance leaks the plugin's env to backend

`CliTransport` spawns subprocesses inheriting the plugin's full
environment. The plugin process may have been started with a
`OPENAI_API_KEY` from one user, and the spawned `gemini` subprocess
sees it (irrelevant to gemini, but visible in `/proc/<pid>/environ` and
process listings). Multi-tenant systems leak credentials between
backends.

**Fix**: `CliTransport` SHALL filter the inherited environment to a
documented allowlist plus the explicit `env` parameter. Default
allowlist: PATH, HOME, USER, LANG, LC_*, TMPDIR, NODE_PATH. Backend-
specific env vars (e.g., `GEMINI_API_KEY` for Gemini) added per
backend. Add scenario.

### B-2: SSE reconnection scenario doesn't bound damage

`HttpTransport` reconnect attempts (3 with backoff) — but during
reconnect, what happens to in-flight prompts? Spec doesn't say. Either
they hang waiting for a response that won't arrive, or they fail.

**Fix**: in-flight prompts SHALL fail with `kind: 'broker-unhealthy'`
when SSE drops; reconnect is for *future* prompts. Add scenario.

### M-3: Cache poisoning vector

Cache key includes prompt + context + git HEAD. But what is "context"?
If "context" is a file list and contents, a malicious file in the repo
could inject content into the cache that later sessions pick up.

**Fix**: cache spec must specify what "serialized context" means
exactly: SHA256 of canonical-JSON of all files in the prompt's
context bundle, with a fixed canonicalization. Plus: cache reads
SHALL verify the stored response was written by the same plugin
version (via embedded version field) before returning.

### M-4: Audit log race with rotation

Daily rotation: at midnight, the file is renamed (or copied + deleted).
If a write is in flight, it could go to the renamed file, the new file,
or fail.

**Fix**: rotation SHALL use file-locking semantics (or rename-then-open
new descriptor) — pick one and specify. Recommendation: open new
descriptor for new day on first post-midnight write; old descriptor
flushed and closed.

### M-5: Wire log unbounded disk usage

`ACP_WIRE_LOG=/path/to/file` opens the file in append mode. There's no
rotation, no size limit. A long-running session in a CI logs every
frame and the file grows without bound.

**Fix**: wire log SHALL have a max size (configurable, default 100 MB).
On reaching, oldest entries truncate or rotate. Add scenario.

---

## Per-proposal findings

### `modernize-toolchain`

#### M-1.1: pnpm signed-commits behavior with husky

Husky's `prepare` script runs on `pnpm install`. If a contributor
invokes `pnpm install` via a hook itself (recursive scenarios), or if
a CI runner caches `node_modules` such that `prepare` never runs, the
hook isn't installed, and the developer gets no pre-commit checks
locally even though CI is green.

**Fix**: add scenario "Hook installation failure surfaces clearly" —
if husky cannot install (e.g., `.git` is missing), `pnpm install` logs
a warning but does not fail. Document in CONTRIBUTING.md that hooks
require `.git` directory.

#### M-1.2: tsgo crashes silently in CI when output is large

Pre-1.0 tools sometimes crash on large input. Tasks T2.5 says "annotate
acp-broker.mjs ... resolve type errors" but if tsgo crashes (rather
than reporting an error), the contributor sees a green CI and a hidden
problem.

**Fix**: tsgo invocation SHALL fail-fast on non-zero exit even if no
errors were printed. Wrap the call to detect "exit 1, no stderr" as a
distinct failure mode.

### `add-testing-and-observability`

#### B-2.1: Property tests with random unicode could DoS the wire log

Property test: "unicode characters in string fields." If fast-check
generates a string with control characters or extremely large
codepoints, and a wire log captures it, the wire log file may contain
content that breaks downstream JSONL readers.

**Fix**: wire log SHALL JSON-stringify all content (which escapes
control chars). Already the case if implementation uses `JSON.stringify`
correctly. Add scenario "Wire log handles control characters" —
input with literal newline in a string field becomes `\n` in the JSONL.

#### M-2.2: OTel propagation through ACP loses information at backend boundary

`_otel.traceparent` is injected into outbound ACP messages, but the
spec acknowledges spans terminate at the subprocess boundary unless
the backend implements its own OTel instrumentation. None of the
backends (Gemini CLI, Codex SDK, Claude SDK) currently propagate.

**Fix**: spec should explicitly note this as a known limitation. Tasks
should not list "propagation" as a benefit; it's "context capture only
at our boundary." Update scenario "Backend without OTel ignores _otel
field" to make this explicit.

#### M-2.3: Log redaction of structured payloads is fragile

Pino redaction operates on field paths. If a redacted field contains
a nested object with the secret in a deeper path, redaction misses
it. Example: `{ env: { GEMINI_API_KEY: '...' } }` redacts; but
`{ headers: { custom: 'GEMINI_API_KEY=...' } }` doesn't because pino
doesn't pattern-match values.

**Fix**: add a separate "value-pattern redactor" pass before logging.
This is what the middleware-and-release proposal's `redaction.mjs`
will do — but the logger's redaction also needs a pattern pass for
keys that escape known paths.

### `add-transport-abstraction-with-gemini`

#### B-3.1: SIGTERM grace period violates user expectation on cancel

`CliTransport` close: SIGTERM, wait 5s, SIGKILL. User cancels mid-
prompt. The cancel path uses `cancel()` (sends ACP cancel), but if the
cancel doesn't return promptly, `close()` will SIGTERM. 5 seconds
between user pressing Ctrl-C and the process actually dying is a long
time.

**Fix**: cancel + close path: send ACP cancel, wait 1s for clean exit,
SIGTERM, wait 2s, SIGKILL. Total budget 3s, not 5s. The 5s budget
applies only to `close()` without prior cancel (clean shutdown of an
idle session).

#### M-3.2: Heartbeat thresholds don't account for backend warmup

10/30/60 second thresholds assume steady state. A `gemini --acp`
fresh process loading a large model can take 15-30 seconds before
emitting first message. Spec would label `quiet` then `possibly_stalled`
within the warmup window.

**Fix**: thresholds SHALL be paused during initial handshake
(`session/new` request) and only start ticking after the first ACP
notification from the backend.

#### M-3.3: Conformance suite doesn't cover backpressure

If the backend emits notifications faster than the client processes
them, what happens? Node streams have backpressure semantics, but
ACP-over-stdio passes through a JSON-RPC parser that may not respect
them.

**Fix**: add scenario "Backpressure: backend emits 1000 events
rapidly" — client receives all events, no events are dropped, memory
usage stays bounded.

### `add-codex-sdk-backend`

#### B-4.1: SDK abort timeout race

Spec: "If the SDK does not honor abort within the timeout, the
transport SHALL emit a warning and continue cleanup." But "continue
cleanup" is undefined. If the SDK is still streaming, calling `close`
on an in-flight stream is itself undefined behavior.

**Fix**: define cleanup semantics. After timeout, the transport
abandons the SDK reference (no more event handlers attached); any
events that arrive are discarded. Logged at warn. Reference may be
garbage-collected eventually; document that misbehaving SDK can cause
memory leaks until.

#### M-4.2: Drift CI doesn't notify on first drift

Spec: drift "posts a summary to a tracking issue." If the issue
doesn't exist, the first drift is silent (where does it post?).

**Fix**: scenario "First drift creates the tracking issue" if not
present.

### `add-claude-sdk-adapter`

#### B-5.1: Permission flow has a deadlock vector

`acceptEdits` mode: file-edit auto-approved. But Claude can issue tool
calls via subagents that also use Edit. The spec doesn't cover
delegation. Worse: if a subagent is denied permission and the parent
session waits for completion, deadlock if the subagent's failure
isn't surfaced.

**Fix**: scenario "Subagent permission denial surfaces to parent" —
when a sub-tool-call is denied, the SDK's `result` event captures the
denial; the translator surfaces it; the parent session continues
without deadlock.

#### M-5.2: Translator could emit events out of order

Spec: translator events forwarded as `session/update`. If the SDK
emits events on a different timeline than the prompt's main message,
ACP order may not match logical order.

**Fix**: spec should assert ordering: `assistant` content emitted in
the order the SDK delivers them. `tool_use` emitted before
`tool_result` for the same tool call ID. Add scenario.

#### M-5.3: ANTHROPIC_API_KEY env var conflicts with credentials.json

If both are present: which wins? Claude Agent SDK likely prefers the
env var. Spec doesn't say. Affects users running both Claude Code
(uses credentials.json) and a script with `ANTHROPIC_API_KEY` set.

**Fix**: add scenario "Env var precedence over credentials file" —
documented behavior, matches SDK behavior.

### `add-app-server-transport-and-marketplace-split`

#### B-6.1: Workspace migration mid-PR breaks ongoing work

Tasks T1.1-T1.4 restructure the file system. Other PRs in flight at
the same time will conflict. Spec doesn't address.

**Fix**: spec should require a freeze on `lib/` modifications during
this proposal's implementation window. Document in CONTRIBUTING. Add
scenario asserting the freeze.

#### M-6.2: Plugin command names collide between plugins

`/gemini:review`, `/codex:review`, `/claude:review` — fine. But what
if a user installs only `claude@artagon-acp` and `codex@artagon-acp`
and they both register a `/agent:cost` command (from the middleware
proposal)? Cost command is shared, but how is it deduped?

**Fix**: spec for `/agent:*` commands MUST clarify ownership: either
(a) only one plugin registers them, (b) all plugins register and
Claude Code dedupes (research how), or (c) `/agent:*` is a separate
"agent-shared" plugin installed alongside.

#### M-6.3: Marketplace.json schema versioning unaddressed

If Anthropic changes the marketplace schema, this proposal's
marketplace.json may break.

**Fix**: spec should not over-specify schema; just reference current
docs. Acceptable. Note for implementation.

### `add-middleware-and-release`

#### B-7.1: Retry middleware on idempotent vs non-idempotent operations

Retry on rate-limit is fine for read-only operations (review). What
about a `rescue` invocation that started executing? If the SDK got
the prompt, started running tools, then hit a rate-limit on a
subsequent tool call — retrying the *prompt* re-executes the tools.

**Fix**: retry middleware SHALL NOT retry prompts that have already
emitted any `tool_call` notification (tools have side effects).
Retry only applies to prompts that failed *before* tool execution
began. Add scenario.

#### B-7.2: Cache key collision via context truncation

Cache key uses serialized context. If a prompt's context is large
(big repo), the SHA256 input is huge but the digest is 256 bits.
SHA256 collisions are computationally infeasible to attack, but if
the canonicalization is buggy, two distinct contexts can hash to the
same value.

**Fix**: cache key includes the *length* of the canonical-JSON in
addition to its SHA256. Cheap belt-and-suspenders.

#### M-7.3: Audit log under heavy concurrency

Multiple concurrent sessions writing to different audit files: fine.
Same session with multiple in-flight prompts (does ACP support this?
SDK transport may): writes interleave at the line level. Each line
is one record, but Node's `fs.appendFile` is not atomic across
multiple write calls on the same descriptor.

**Fix**: audit middleware MUST serialize writes per session. Use a
write queue or `appendFileSync` (blocking, but acceptable for audit).
Specify in scenario.

#### M-7.4: Cost middleware double-counts on retry+fallback

If a prompt is retried (1 tokens recorded) and then falls back (more
tokens), the spec says cost records both attempts. But if the user
queries `/agent:cost <session-id>`, do they see total or per-attempt?
Ambiguous.

**Fix**: clarify schema. Per-attempt records aggregated to a session
total. Both visible at detail view.

#### M-7.5: Changeset CI check on docs-only PRs needs precise detection

Spec says "PRs touching code ... opt-out for docs-only." But "docs"
includes inline comments, JSDoc additions, README changes. Detection
via path globs is brittle: a JSDoc-only change may touch a `.mjs`
file.

**Fix**: detection by path: if all changed paths match
`/^docs\/|^README\.md$|^.changeset\//`, skip changeset requirement.
Otherwise require. Documented as the bright line.

---

## Verdict

7 proposals, 25 findings (8 blocking, 13 major, 4 notes).

**New blockers worth applying before Round 3**:
1. CliTransport env filtering (B-1)
2. SSE in-flight prompt failure on disconnect (B-2)
3. SIGTERM grace period for cancel (B-3.1)
4. SDK abort cleanup semantics (B-4.1)
5. Subagent permission flow scenario (B-5.1)
6. Workspace migration freeze policy (B-6.1)
7. Retry restricted to pre-tool-call failures (B-7.1)
8. Cache key length-and-hash combo (B-7.2)

Status: **Changes requested**.
