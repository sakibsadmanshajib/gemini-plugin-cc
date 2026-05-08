# ACP Test Fixtures

Fixtures are JSONL recordings of an ACP wire conversation between the plugin (client) and the backend (server). Each line is a directional record: `{"dir": "out", "msg": {...}}` for messages the client sends, `{"dir": "in", "msg": {...}}` for messages the server pushes.

## Format

```jsonl
# Optional comments — lines starting with # are ignored.
# Empty lines are ignored.
{"dir": "out", "msg": {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"clientInfo": {"name": "gemini"}}}}
{"dir": "in",  "msg": {"jsonrpc": "2.0", "id": 1, "result": {"capabilities": {}}}}
{"dir": "out", "msg": {"jsonrpc": "2.0", "id": 2, "method": "session/new", "params": {"cwd": "/tmp/x", "mcpServers": []}}}
{"dir": "in",  "msg": {"jsonrpc": "2.0", "id": 2, "result": {"sessionId": "s1"}}}
{"dir": "in",  "msg": {"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": "s1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "hello"}}}}}
```

## Replay semantics

`replayFixture(path, transport)` reads the file in order and:

1. Pushes every leading `"in"` record to the client (server-initiated notifications/responses).
2. Waits for the next `"out"` record to be sent by the client.
3. Compares the observed message against the fixture's expected message.
4. On match, advances; pushes any subsequent `"in"` records up to the next `"out"`.
5. On divergence, rejects with a diff.
6. Resolves with `{ matched, total }` when every `"out"` is observed in order.

## Volatile-field normalization

The replayer strips these fields before comparing:

- Top-level `id` — request ids are nondeterministic across runs.
- `params.timestamp` — wall-clock noise.
- `params._otel` — OTel propagation field is opt-in and varies.

Match a fixture by method + structural params, not by id.

## Recording fixtures

Wire-log capture (`ACP_WIRE_LOG=/path/to.jsonl`) lands in a follow-up change (`add-testing-and-observability` T6). Once available, the captured wire log + a small sed/jq pipeline produces a fixture; until then, fixtures are hand-authored.

## Canonical fixtures

`tests/integration/fixtures/gemini-rescue-success.jsonl` — initialize → session/new → session/prompt → session/update notifications → result.

`tests/integration/fixtures/gemini-cancel-mid-stream.jsonl` — initialize → session/new → session/prompt → session/update notifications → client emits session/cancel before completion.

Add new fixtures under `tests/integration/fixtures/` named `<backend>-<scenario>.jsonl`.
