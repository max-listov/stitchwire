---
title: Product boundaries and transport composition
description: Sources, artifacts, authorization and delivery semantics of the generic transport.
type: architecture
status: active
created: 2026-08-30
updated: 2026-11-24 00:32 +08:00
---

## Source and artifact ownership

`packages/runtime/src` owns broker, agent, configuration, admission and command-line operation.
`packages/client/src` owns the published client entrypoints (`@stitchwire/client`, browser-safe
`@stitchwire/client/contracts` and `@stitchwire/client/enrollment`). `packages/local-client/src`
owns the HTTP-over-Unix implementation shared by SDK and CLI, validation, bounded readers,
cancellation, path discovery and drop-in declaration helpers.
`packages/contracts/src` owns shared door/service/protocol schemas. Contracts import neither the
runtime nor client. The runtime never imports client implementation. Only the declared client
entrypoints are supported package exports; internal cross-package relative imports are bundled,
not public APIs.

The root manifest owns the runtime release version, consumed by `packages/runtime/src/release-version.ts`.
The client manifest owns its independent version. Every workspace manifest is private: npm
receives `@stitchwire/client` and the `stitchwire` runtime only as publishable copies the build
writes into `dist/`, and the `contracts` and `local-client` workspaces are bundled into them rather
than published. Runtime is a self-contained Bun-target JS bundle, not a native executable. Client declarations include only their internal schema closure.

## Requests and authorization

The caller's owner client encodes a domain request. `createServiceFetch` verifies the declared
operation and passes opaque JSON to the unary or shared stream plane. The local agent chooses a
serving broker lane — unless the call is addressed to the calling node itself, which is served
locally without a broker: the executor and the grant table that authorise it are both already on
that node, so the broker's copy adds distance and no independent check. A node declaring
`serves: false` keeps the routed path, because the broker is what refuses a non-serving target.
A grant names service-wide read access or one exact operation; the broker does
coarse route admission, while the target loads the current owner descriptor and authoritatively
checks revision, operation and effect. The target forwards through the configured private Unix
endpoint. Caller payload never chooses
a filesystem path, executable or grant. Domain request IDs are not transport request IDs.

An operation's `effect` is `read` or `write`, and nothing else. The closed vocabulary is what makes
service-wide read access delegable: the owner classifies its own operations in the descriptor, and
a `service-read` grant then admits every one of them without the fleet naming any. A third word
would leave that classification unreadable, so a descriptor carrying one is refused at the
boundary rather than routed as "not a read".

The command allowlist accepts only absolute executable paths and explicit command profiles.
There are no built-in domain readers, file-export bindings or alternate owner protocols.
A service operation with the same name as an undeclared command remains independently callable;
command requests receive the ordinary policy refusal, never a service redirect or fallback.
Unsupported profile objects fail configuration validation. Consumers use the declared Stitchkit
service contract directly. A Wire projection derives operation ids and stream facts from that
contract; node configuration stores only its absolute descriptor path.

Command and stream children receive authenticated node attribution as `STITCHWIRE_CALLER`.
It overrides inherited or profile-supplied values and is not an application end-user identity.

Before dispatch, one node-level selector waits within the request deadline for either a connected
lane or an authoritative presence snapshot. Service, command and stream select once; confirmed
absence still reaches one broker so policy remains authoritative. Event publication waits inside
a bounded pending slot for a connected lane. Once any operation is physically handed off, Wire
does not select another lane or replay it.

Transport failures carry `transportCause`: `no-connected-lane`, `presence-pending-timeout`,
`target-offline` or `lane-lost-after-dispatch`. `detail` is human explanation, never a branching
API. Before-dispatch refusal can prove `not-dispatched`; after handoff, timeout or disconnect may
be `unknown`. A received owner response proves receipt, not business success.

A command call's deadline, cancellation and cleanup on the target are described in
[the declared command lifecycle](command-lifecycle.md).

## Streams and events

For service streams, operation `limits.timeoutMs` bounds opening the owner HTTP response;
`response.lifetimeMs` bounds its lifetime after headers. When no lifetime is declared, the finite
operation timeout also supplies the lifetime budget. `createServiceFetch` sends that lifetime as
the stream request `timeoutMs`. Target binding `limits.timeoutMs` caps both budgets; requests above
the binding or declared lifetime are refused before execution, never silently shortened.
The executor clears the opening deadline at response headers and arms a separate lifetime deadline.
An explicit caller cancellation can end either phase. `idleTimeoutMs` is independent and, when
absent or zero, quiet intervals do not end a stream. Unary duration semantics are unchanged.

Fixed stream profiles constrain executable, input, output, duration and concurrency. Declared
service streams use the same sequence, credit, cancellation and terminal delivery machine, but
their bytes come from the owner's existing Unix HTTP endpoint. Stitchkit owns the NDJSON envelope
and explicit domain terminal; Wire treats it as opaque bounded bytes. Remote credit
is permission to send bytes, not a local admission lease: an uncredited chunk is not buffered.
Cancellation releases exact resources; consumer departure does not wait for a quiet source to speak.
Every stream a producer stops ends in an explicit terminal frame, including a timeout that arrives
while the producer waits for credit; a consumer never has to infer termination from silence.
Terminal frames carry retryability separately from the terminal reason: a producer ceiling is a
`request` refusal, permanent for that request until its bounds or the request change, while a busy
node's `capacity` refusal at the same `limit` reason clears on its own. Everything else a producer
fails on stays unclassified and therefore retryable.

Event publication fans out to the lanes connected at the single dispatch point. The first accepted
lane settles success independently of the other lane; reconnect after handoff does not add another
attempt.
The node decides first and the brokers after. The node's own pending and rate limits
(`admission.maxPendingPublishes`, `maxPublishesPerMinute`) are checked before anything is delivered:
an event the node refuses reaches nobody, local readers included. Once admitted, a node's own
readers hear the event at once, without waiting for any broker; what a broker then answers (a
refusal for its own rate or policy, no connected lane, a lost acknowledgement) is told to the
publisher and does not take the local delivery back, since a refusal from one broker says nothing
about another and local delivery exists so that a node's readers never depend on one. A physical
lane keeps its own bound on publishes awaiting its acknowledgement. Subscribers reconcile producer boot/seq, bounded retention and explicit gaps. Broker
history is volatile; durable resync belongs to owners.

Topics come from two places. Fleet topics are fixed in broker configuration. Owner topics are
declared by the producing node inside a namespace the broker grants to that producer: the node reads
the descriptors its owners installed — listed in `events.descriptors` or placed as `*.json`
files in the sibling `events.d/` drop-in directory (`events.dropInDir`, defaulting beside
`node.json` unless set to `null`) — and declares the complete set to every broker lane on connect
and on change, and the broker judges each name on its own. An owner adds or removes a topic by
writing its own descriptor file without editing `node.json` or restarting the agent. See
`topic-namespaces.md`.

Services come from two places the same way. Configured bindings and grants are fixed in node and
broker configuration. Owner services are declared by the serving node inside the service-name
prefixes the broker grants it: each file the owner installs — listed in `services.descriptors` or
placed as `*.json` in the sibling `services.d/` drop-in directory (`services.dropInDir`, defaulting
beside `node.json` unless set to `null`) — carries one binding and who may call it, the node serves
it from the next call, and every broker lane hears the complete set of grants on connect and on
change. A node grants calls only to itself. An owner adds, updates or removes a service or reader by
writing its own file without editing `node.json` or restarting the agent. See
`service-declarations.md`.

The fleet's own tables — who belongs to the fleet and what each pair of nodes may do — come from one
signed manifest. Every broker and node configured with `fleet.trust` keeps the newest signed
edition, projects its own tables from it, rewrites them when they differ and reloads in place.
Brokers hand each node the part it may hold; members that keep the full bundle repair brokers that
lost it. See `fleet-bundle.md`.

Broker `/health` reports its endpoint identity, the last observed disconnect and event-loop delay.
Delay is `unknown` before the first sample and measured afterwards as the last value and the maximum
over the trailing five minutes; a new maximum above the diagnostic threshold enters the canonical
bounded audit. This proves that the event loop was late after it resumed. It cannot identify the
competing process or provide scheduler/CPU isolation.

## Framework composition

Stitchkit owns contracts, Unix HTTP transport, application resource lifecycle, bounded admission
and stream framing. Wire owns routing, protocol credit, transport result maps and authorization.
Physical work retains admission until settlement even when a caller's wait is cancelled.

All workspace manifests pin the same exact framework version; the installed dependency graph
must resolve that version once. That version supplies contract streams, pull-driven Unix
responses, key-dependent admission and the bounded revision signal used by multi-home routing;
Wire does not copy those mechanisms. The selector snapshots the revision before inspecting lanes,
so a transition between inspection and wait is observed immediately rather than becoming a missed
wake-up. Framework peer-rejection conformance verifies the production realtime contract without
replacing Wire's transport error mapping.

`createLiveStateController` belongs to applications that supply a consistent snapshot/event
source and domain reducer. Wire's bounded frame queues, volatile retention and protocol credit
do not define such a domain snapshot. Transport reconnect is not application resynchronization.

Stitchkit request-scoped `onPhase` binds native phases to a snapshot of the transport tuple
and lane. Only `producer/topic/bootId/seq`, lane, framework request ID and phase timings enter the
existing bounded publication audit. No payload, cursor, credentials or private Socket.IO fields
are retained by the hook. Direct agent users without a trace sink install no hook.

`engine-handoff` means packet creation, not physical flush. `engine-ack-received` means decoder
observation, not physical network arrival. `settled` includes invalid ACK validation; it does not
mean accepted. The separate `lane-result` owns the validated transport outcome. Native phase
elapsedMs starts at the framework invocation; lane-result timing starts before lane admission.
Their timeout callbacks can race. Door response readiness is not caller receipt, and cross-host
clock differences are not RTT. The dependency upgrade and instrumentation are not an ACK fix.

`createDiagnosticJournal` owns the audit writer's FIFO queue, retained-byte bounds, loss counters,
finite files, rotation and exclusive lock. Wire supplies only its versioned event schema and maps
the framework snapshot into broker health. `test/framework-journal-contract.test.ts` executes the
published primitive's ordering, pressure, rotation and lock contract.

Event-loop sampling is a managed Stitchkit schedule: the framework owns cadence, drift correction
and shutdown, while Wire owns the measured high-water mark, the 250 ms warning threshold and the
transport audit event.

## Internal modules

Producer admission and session registration live in `stream-producer.ts`; session orchestration
owns process/service lifetime, ordered sends and terminal delivery. `stream-producer-source.ts`
reads raw and framed sources using the framework NDJSON parser. `stream-producer-credit.ts` owns
remote byte permission: zero initial credit, explicit grants, consumption after accepted chunks and
cancellable waits. Local lease release cannot replenish remote credit.

Bounded request/response consumption and reader cleanup are Stitchkit's `readBoundedBody`. Boundary
adapters of the local client supply request/refusal or response/delivery error classifications; source cancellation cannot
replace the original failure. Service requests without a body encode the empty JSON object.

Protocol schemas are grouped under `contracts/src/protocol` by identity, failure, bounds, release,
RPC, stream and event. Configuration is separated into paths, broker policy, profiles, node policy
and disk loading. The agent composition has distinct lane transport, resilient event iteration,
presence merge, multi-home routing and managed application lifecycle. CLI I/O, rendering, config
creation and door access are separate from command dispatch; broker health contracts are separate
from connection and routing implementation. Retired source paths are absent.

Schema construction must remain in the bundle. Workspace source packages do not advertise blanket
`sideEffects:false`: Bun 1.3.14 drops re-exported schema/client initialization with that annotation
in this layout. The packed runtime gate verifies actual executable exports rather than trusting
bundle success or a file containing only export names. Client import still starts no daemon.
