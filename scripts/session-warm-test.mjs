/**
 * One-process streaming smoke test for the session policy.
 *
 * Drives three sequential turns through ONE codex streaming supervisor
 * (cached by (backend, cwd)) so the codex app-server subprocess is
 * spawned once and reused for all three turns:
 *
 *   1. warm reuse        → use whatever session start() created
 *   2. --new-session     → context.session.fresh = true
 *   3. --session <id-1>  → context.session.id = the id from turn 1
 *
 * Prints (sessionId, cachedInputTokens) for each turn. If session-reuse
 * is working, turn 1 and turn 3 share an id; if not, all three differ.
 */

import { createAgentContext, withOverrides } from "#lib/agent-context.mjs";
import { BACKEND_NAMES } from "#lib/backends/names.mjs";
import { runStatelessTurn } from "#lib/runners/dispatch.mjs";
import { shutdownAllStreamingRunners } from "#lib/runners/streaming/registry.mjs";

const base = createAgentContext({
  cwd: process.cwd(),
  env: process.env,
  dispatch: { streaming: "on", facade: "default" }
});

async function turn(label, ctx, prompt) {
  const t0 = Date.now();
  const result = await runStatelessTurn(
    BACKEND_NAMES.CODEX,
    { prompt, cwd: ctx.cwd, env: ctx.env, timeoutMs: 120_000 },
    ctx
  );
  const ms = Date.now() - t0;
  const cached = result.usage?.cachedInputTokens ?? result.usage?.cached_input_tokens ?? "?";
  process.stdout.write(
    `[${label}] sid=${result.sessionId ?? "null"} cached=${cached} ms=${ms} text=${JSON.stringify(result.text)}\n`
  );
  return result.sessionId;
}

try {
  // Turn 1: warm reuse (no session policy) — gets the session start() created.
  const id1 = await turn("reuse-1", base, "Reply with: alpha");

  // Turn 2: --new-session semantics.
  const fresh = withOverrides(base, { session: { action: "fresh" } });
  const id2 = await turn("fresh-2", fresh, "Reply with: beta");

  // Turn 3: --session <id1> — resume the id from turn 1.
  const resumed = withOverrides(base, {
    session: { action: "resume", id: id1 }
  });
  const id3 = await turn("resume-3", resumed, "Reply with: gamma");

  process.stdout.write(
    `\nids: 1=${id1} 2=${id2} 3=${id3}\n` +
      `expect: id1 !== id2, id1 === id3 ⇒ ${id1 !== id2 && id1 === id3}\n`
  );
} finally {
  await shutdownAllStreamingRunners();
}
