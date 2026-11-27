---
title: Bounded service request documents
description: Payload, encoded envelope and admission limits for JSON service requests.
type: architecture
status: active
created: 2026-09-10 08:20 +07:00
updated: 2026-11-16 19:47 +08:00
---

Service requests contain one JSON document of at most 1,048,576 UTF-8 bytes. This ceiling
supports document-oriented operations without making the shared broker a bulk upload store.
An endpoint without `maxJsonBodyBytes` receives a 65,536-byte default. A larger request
requires explicit owner opt-in; the minimum of operation and target binding limits wins.
Changing the protocol ceiling does not enlarge installed descriptors, bindings or grants.

On Unix HTTP, the payload is a string within a JSON routing envelope. `jsonEnvelopeBytes` reserves
six encoded bytes per payload byte plus 4096 for bounded identifiers, keys and numeric metadata.
The sixfold bound covers JSON string escaping conservatively, including U+0000. Valid inner
JSON already escapes string control characters; whitespace and backslashes still grow when
embedded in an outer JSON document. Limits apply to bytes, not JavaScript string length.

Local unary and stream-open bodies and the owner Unix transport use that envelope bound.
At the ceiling it is 6,295,552 bytes, below the SDK's 8 MiB HTTP limit and the broker's
12 MiB maximum decoded lane frame. Broker lanes use [binary packets](lane-encoding.md), so
the payload is not escaped again on those hops. Configured lower broker frame limits remain
authoritative and apply before compression. Command calls reserve the decoded stdin and complete argv budgets before applying the same JSON expansion
bound. Profile streams reserve stdin, argv and routing metadata independently of service payloads.
Event publication reserves the maximum encoded event data. Decoded profile and event limits remain
unchanged even when their control-character representation needs a larger HTTP envelope.

Strict schema field bounds imply the Unix envelope ceilings; schema validation does not serialize
the complete envelope again. Raw HTTP body limits and UTF-8 payload validation remain authoritative.

Admission remains bounded. Per executor, 32 simultaneous maximum payloads account for 32 MiB
of UTF-8 content; one conservative encoded copy per call is 192.125 MiB. A planning model
with decoded and encoded JavaScript strings at two bytes per code unit plus a UTF-8 transport
buffer budgets 21 MiB per active request (672 MiB at 32, including envelope metadata). A maximum response adds up to 1 MiB
of content per unary call, plus its own buffers. These are representation budgets, not a measured
RSS cap: parser objects, socket buffers, queues and allocator overhead are additional. The broker
has independent admission limits and carries requests in both directions; deployment capacity
must budget each process and its configured concurrency, not multiply the executor limit across
the entire system. Small defaults, per-service concurrency and lower explicit limits avoid paying
the maximum for every service. No concurrency or retention limit is increased for large bodies.

The request is fully bounded before dispatch. There is no multipart, raw-body, durable chunk
storage, automatic retry of writes or command-plane fallback. Streaming describes the response,
not an unbounded upload. Cancellation releases body readers and admission leases.

The executor's unary deadline starts before descriptor loading and covers socket preflight,
dispatch and response consumption, including local self-calls. Cancellation interrupts waiting
for preflight and propagates to descriptor reads; a late read cannot dispatch an operation.
Before dispatch, cancellation or expiry reports `not-dispatched`; after dispatch, delivery
remains `unknown` unless the transport proves that nothing was sent.

Stream opening starts at the same entry point, initially bounded by the binding timeout.
Once the descriptor is known, its operation timeout can only narrow that opening deadline:
elapsed preflight is not reset. After response headers, the separately admitted stream lifetime
begins. The unary/opening timeout does not truncate that lifetime.

The expanded range requires a coordinated runtime upgrade before consumers opt in to larger
descriptors. Runtime peers retain their exact-version handshake. No mixed-version fallback is
provided. Source readiness does not activate consumer configuration or publish a release.
