# Spec Delta: transport-sdk

## ADDED Requirements

### Requirement: SdkTransport runs vendor SDKs in-process

`SdkTransport` SHALL provide a generic `AcpSession` implementation
backed by a vendor SDK. It SHALL accept an `sdk` instance and a
`translator` function, and SHALL invoke the SDK's streaming run method
for each prompt, translating events to ACP `session/update` shapes.

#### Scenario: Streaming events translated

- **GIVEN** an SDK whose streaming run yields three events
- **WHEN** `prompt('test')` is called
- **THEN** the transport iterates the three events
- **AND** for each event, calls `translator(event)`
- **AND** for each non-null translation, dispatches it via `onUpdate`
  handlers
- **AND** the prompt promise resolves when the stream ends

#### Scenario: Untranslatable event logged

- **GIVEN** an event for which `translator` returns `null`
- **WHEN** the event is processed
- **THEN** no `session/update` is dispatched
- **AND** a debug log records the untranslatable event type
- **AND** an internal counter increments for drift detection metrics

### Requirement: SdkTransport propagates abort signals

`SdkTransport` SHALL use an `AbortController` per prompt. `cancel()`
SHALL signal the controller and SHALL ensure handler invocation stops
within a configurable timeout (default 500 ms). If the SDK does not
honor abort within the timeout, the transport SHALL emit a warning and
continue cleanup.

#### Scenario: Cancel stops handler invocation promptly

- **GIVEN** a streaming prompt in progress with handler invocations
  in flight
- **WHEN** `cancel()` is called
- **THEN** within 500 ms, no further handlers are invoked
- **AND** in-flight handlers complete (not interrupted mid-call)

#### Scenario: SDK ignores abort, transport warns

- **GIVEN** a misbehaving SDK whose stream continues for 2 seconds
  after abort signal
- **WHEN** `cancel()` is called
- **THEN** at the 500 ms mark, a `warn` log records "SDK did not honor
  abort within timeout"
- **AND** the transport tracks the misbehaving SDK in metrics
- **AND** the prompt promise rejects with `kind: 'cancelled'`

### Requirement: SdkTransport conforms to AcpSession

`SdkTransport` SHALL pass the conformance test suite when supplied with a conforming SDK and translator.

#### Scenario: Conformance with mock SDK

- **GIVEN** a mock SDK that scripts events for each prompt
- **WHEN** the conformance suite runs against
  `createSdkTransport({ sdk: mockSdk, translator: identityTranslator })`
- **THEN** all conformance tests pass

### Requirement: SdkTransport normalizes errors

The transport SHALL catch SDK errors and re-emit them as ACP error
shapes with `kind` field categorizing the error. The required kinds
are at minimum:

- `auth-required` — credential failure
- `rate-limited` — quota or throttling
- `network` — transport-level error
- `aborted` — user cancellation
- `internal` — unexpected SDK error

#### Scenario: Auth error normalized

- **GIVEN** the SDK throws an auth-equivalent error
- **WHEN** the prompt promise rejects
- **THEN** the rejection error has `kind: 'auth-required'`
- **AND** the transport's health transitions to `auth_required`

#### Scenario: Internal error preserved with raw

- **GIVEN** the SDK throws an unexpected error
- **WHEN** the prompt rejects
- **THEN** the rejection error has `kind: 'internal'`
- **AND** the original error is attached as `cause`
- **AND** a structured log records the unexpected error for triage

### Requirement: Abort cleanup is bounded and well-defined

The transport SHALL bound abort cleanup: when the SDK does not honor an abort signal within the configured timeout, the transport SHALL detach all event handlers from the SDK reference and discard subsequent events. The SDK reference SHALL be released (allowing garbage collection), and the transport SHALL log the misbehavior at warn level.

#### Scenario: Abandoned SDK does not leak event delivery

- **GIVEN** a misbehaving SDK that continues streaming for 2 seconds
  after abort
- **WHEN** the abort timeout (500 ms) elapses
- **THEN** the transport calls its internal detach to remove all
  listeners on the SDK
- **AND** the transport's user-facing handlers do not fire for any
  event after detach
- **AND** the transport logs at warn level with the SDK's identifying
  metadata

#### Scenario: Memory bound on misbehaving SDK

- **GIVEN** a session that experienced an abandoned SDK on a prior prompt
- **WHEN** a new prompt starts (creating a fresh SDK instance)
- **THEN** the prior SDK reference is released by the transport
- **AND** Node's GC can reclaim it (no retained references in
  transport state)
