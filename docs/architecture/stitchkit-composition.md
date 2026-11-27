---
title: Wire composition on published Stitchkit primitives
description: Ownership, bounded mechanics and causal evidence on the manifest-pinned Stitchkit release.
type: architecture
status: active
created: 2026-08-28
updated: 2026-11-25 18:16 +08:00
---

## Transport and ownership

Wire owns authenticated node identity, ACL, lane selection, exact epoch/sequence/gap
semantics and declared local service policy. Payload remains opaque. The exact Stitchkit release is
pinned by each workspace manifest; the SDK package, which a consumer installs next to its own
Stitchkit, declares it as a peer dependency and keeps the exact release for its own build and tests. Stitchkit owns Unix I/O, bounded regular-file reads, polled JSON caches, directory-appearance watches, atomic writes and exclusive locks (`stitchkit/files`), resource lifecycle, typed NDJSON framing,
admission leases and bounded
ordered/latest delivery channels. Domain contracts, explicit per-file byte ceilings, drop-in policy and declaration force order stay with Wire and its service packages.

`src/door/streams.ts` declares item framing, strict newline and terminal completion.
Server contracts and SDK readers use this policy. SDK Wire readers still validate
door version, source, byte accounting, base64, sequence and terminal consistency.
Headers have an open deadline; finite streams also have duration. Quiet subscriptions
have no inactivity timeout. Kit releases I/O before terminal yield. Wire keeps
`endOnDeparture`: ending a parked domain iterator requires its explicit return hook.
Local source shutdown produces a transport terminal, not an apparently successful EOF.
Process profile NDJSON uses the same bounded parser with its deliberate final-line
allowance; it has no door terminal envelope.

## Admission and channels

Node execution/profile, stream, publication and SDK slots use Kit leases. Broker RPC,
stream caller/producer, event subscription/epoch rate and peer probes use independent
Kit admission policies. Logical request maps retain identity and callbacks, not duplicate
permit counts. Profile pools compose with global pools, rolling back rejected acquisitions.
Rate hints derive from monotonic windows; concurrency refusals have no invented retry time.
Physical work releases its permit only on actual settlement, including a synchronous ACK
paired with a still-pending send promise. Caller withdrawal settles its outer wait while physical
admission stays owned until handed-off work settles.

StreamConsumer, EventConsumer, LocalEventLane and broker delivery use Kit channels.
Terminals have a reserved slot; byte bounds cover retained payloads or the existing decoded
stream-byte budget. Local acceleration runs only after the same canonical node publish/subscribe
policy decision as a broker lane; it is never a second authority. Its overflow never blocks a
publisher. Wire retains only
gap/epoch provenance beside channels; ordered resume, latest coalescing and boot replacement
must remain distinguishable. Closing discards memory and wakes pending readers.

Network credit stays in Wire: it starts at zero and changes only through authenticated
partial remote grants and transmitted chunks. Kit `createCreditWindow` starts full and
replenishes a local lease on release. They represent different permissions; substituting
one would manufacture network authority. Existing exhaustion/replenishment/ceiling tests
remain the acceptance for this protocol state, not a parallel generic local credit engine.

## Publication evidence

Runtime stderr passes through Stitchkit `createBoundedLogger`. Errors remain structured;
secret-named fields and configured URL credential/query patterns are redacted before bounds
are applied. Default limits are 4000 characters per string, 100 members per collection,
depth 6 and 65536 bytes per structured entry. Sink failures do not escape into transport work.
CLI result rendering and the schema-bounded durable audit are separate channels.

Stitchkit `repeatLimited` groups warnings and errors for one minute, retaining at most 256
kinds. It emits `repeatedSinceLastWrite` on expiry, a subsequent write or eviction. An
unreferenced timer never holds the process open. Information entries are never held back.

Descriptor projection requires a declared effect on every Stitchkit endpoint. Only response
budget overrides live in Wire; the browser-only descriptor reader still validates the closed
effect vocabulary without loading the server toolkit.

The service raw route declares the contract prefix and `invokeService` action before body
parsing or admission. A request context can therefore attribute early refusal to the same
operation as successful dispatch. The SDK feed scopes its input-free contract with the
composed door path as prefix; it declares no fictitious path parameters or body arguments.

Socket room replay assumes an application snapshot and revision. Wire retains its authenticated
lane maps, explicit credit and epoch/sequence/gap state rather than treating them as rooms.
Durable process notification outboxes and lifecycle ledgers are not substitutes for diagnostic
journals or application resource shutdown. They are not part of Wire's current service surface.

Each installed agent writes metadata to `<agentSocket>.publication-audit.jsonl`:
door-received → lane-dispatch → lane-result → door-response-ready. Tuple is
producer/topic/bootId/seq; each lane names its declared ID. `elapsedMs` is local monotonic
duration, while `ts` is UTC for correlation. Broker audit independently records acceptance.
`door-response-ready` does not prove socket flush or caller receipt. SDK failures retain
startedAt/elapsedMs/headersMs/timeoutMs/phase/callerAborted under `metadata.timing`.
No retries, timeout increases or new polling timer are introduced.

The node journal is asynchronous,256 queued records,8 MiB per generation and two old
generations, mode 0600. It uses the existing rotating audit writer. Payload, cursor value,
headers, credentials and owner DTOs are excluded. `publicationAudit` in local status
reports bounds, queued/dropped/writeFailures; status marks lifecycle health unhealthy on
lost diagnostics. The audit resource closes after lanes and flushes actual pending writes.

A consuming service retains caller failure metadata; its restart defines a new observation epoch,
not a transport fix. Historical unknown outcomes cannot be retrospectively attributed
without the missing exact caller tuple. A future unknown must be joined with node phases
and broker acceptance before assigning a cause. Cross-host timestamp differences alone
are not RTT. The separate observation task owns that evidence and 24h acceptance.
