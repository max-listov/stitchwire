# @stitchwire/client

Optional typed Node/Bun client for the current Stitchwire local Unix door. One agent per
machine owns the broker connections. This package starts no daemon, opens no network
listener, reads no token file and retries nothing automatically. Importing it does not start an
agent: it talks to the one already running on the machine.

Install the SDK from npm.

```sh
bun add @stitchwire/client
# or
npm install @stitchwire/client
```

For offline verification or local development, build and test a local tarball with
`bun run check:client-package` from the repository root and install the packed archive path.

```ts
import { createWireClient, defaultWireSocketPath } from '@stitchwire/client';

// The agent's default door; a remote caller's input never chooses this path.
using wire = createWireClient({ socketPath: defaultWireSocketPath() });
const result = await wire.invokeService({
  to: 'worker',
  service: 'example.catalog',
  revision: '1',
  operation: 'lookup',
  payload: JSON.stringify({ key: 'example' }),
  timeoutMs: 2_000,
});
if (result.outcome.status === 'failure') {
  // Unknown delivery is not evidence that the owner did not execute the operation.
  console.error(
    result.outcome.code,
    result.outcome.delivery,
    result.outcome.transportCause,
    result.outcome.retryAfterMs,
  );
} else {
  // Receipt is not domain success. Validate status and payload with the OWNER client/schema.
  console.log(result.outcome.httpStatus, result.outcome.payload);
}
```

`defaultWireSocketPath()` resolves `~/.local/state/stitchwire/agent.sock` unless
`STITCHWIRE_AGENT_SOCKET` or `STITCHWIRE_STATE_DIR` is set; it does not probe for a running agent.
The service above is an example, not an install command.
The agent, owner binding and service-read or exact operation grants must already be provisioned by
the operator.

## API

- `invokeService({to, service, revision, operation, payload, timeoutMs}, {signal?})`: generic operation, separate transport outcome and opaque owner JSON.
- `serviceDescriptorFromContract(contract, policy)`: derives operation ids, exact static paths and stream transport
  facts and the required `read` or `write` effect from each owner endpoint. Set `responseBytes`
  to a map of operation names to byte limits for exceptions to the 262144-byte default.
- `createServiceFetch(wire, {to, descriptor, baseUrl})`: injected owner ClientFetch. Virtual
  paths select only declared operations; unary and contract-stream responses share this adapter,
  with no network fallback or automatic grants. Request bodies are consumed only up to the
  operation's byte ceiling. `WireServiceError.outcome` preserves delivery certainty, refusal,
  retry hint and diagnostic, while `WireServiceError.transportCause` exposes the validated route
  cause directly.

- `createServiceIngress({descriptor, handler, bodyTimeoutMs?})`: the owner's side of the same door. It returns a fetch
  handler for the node's envelope POST; the owner serves it on its Unix socket. Anything the descriptor
  does not declare (another service or revision, an unknown operation, `v` other than 1, a body that is
  not JSON or a payload past the operation's `requestBytes`) is answered HTTP 400 `{"error":"invalid-request","detail":"…"}`
  and never reaches `handler`. Everything else reaches `handler` as `POST <operation path>` with the payload
  as its JSON body and the node's cancellation on `request.signal`.
  `bodyTimeoutMs` (integer, 1 to 30000) is the deadline for reading the envelope: a body not complete
  by then is cancelled and answered 400 `invalid-request` ("service envelope was not read within its
  deadline") without calling `handler`. It defaults to the longest budget the descriptor declares (a
  stream operation counts its `lifetimeMs`), since the node refuses a call longer than its operation's
  budget. It ends when the envelope is read: `handler`, streamed responses and the node's cancellation
  on `request.signal` are not under it. Create the ingress once per descriptor, not per request.
- `serviceCaller(context)`: `{caller, operation, id, traceId}` of the request `createServiceIngress` built,
  `undefined` for any other request, including a copy or clone of one and a request carrying the same
  headers. `context` is the Stitchkit endpoint context (a handler, `authorize`, `beforeHandle` or `onError`);
  the value travels in Stitchkit's `defineRequestIngress` channel.

The node agent dispatches only to an owner socket that is `0600` in a directory no other user can enter. Bind
it with Stitchkit's `bindUnixSocket` (`stitchkit/files`, 0.123.4 or later), which makes the socket `0600` from the
moment it exists: `bindUnixSocket({ path, mode: 0o600 }, (unix) => Bun.serve({ unix, fetch: ingress }))`, or
`createServer({ unix: { path, mode: 0o600 }, … })` for a Stitchkit server. A socket takes the process umask at
bind, so a `chmod` after `listen` leaves it on disk with the wider mode until the `chmod` runs, and the node agent
or a release check that finds it then refuses it.

An owner package can publish the non-authorizing `{descriptor, baseUrl}` composition. The descriptor
already carries the exact static route derived from the owner contract; consumers do not repeat it.
The application supplies only the operator-selected target and the already configured Wire client:

```ts
import { createWireClient, defaultWireSocketPath } from '@stitchwire/client';

using wire = createWireClient({ socketPath: defaultWireSocketPath() });
const result = await wire.invokeService({
  to: 'worker',
  service: 'example.catalog',
  revision: '1',
  operation: 'lookup',
  payload: JSON.stringify({ key: 'example' }),
  timeoutMs: 2_000,
});
```

The source checkout's `examples/service/run.ts` includes the actual owner
contract, Stitchkit typed client, two brokers, agents, binding and negative authorization gate.
Its owner client uses `createServiceFetch`; this lower-level snippet assumes that setup exists.

An owner's installer checks the declaration file it is about to write with `parseServiceDeclaration(value)`,
which returns `{ok: true, value}` or `{ok: false, detail}`. The node agent runs this same function on every
declaration file it polls, so the schema verdict and its one-line reason are the node's, with no copy of the
contract on the owner's side. The node also refuses a service outside its granted namespaces or colliding with a
binding it already has; the function does not know the node, so those two checks are made by the node (or by
`stitchwire config validate service <path> --node <node.json>`). The package also exports `ServiceDeclarationSchema`, `ServiceBindingSchema`,
`ServiceDescriptorSchema`, `ServiceLimitsSchema` and the limits `SERVICE_MAX_REQUEST_BYTES`,
`SERVICE_DEFAULT_REQUEST_BYTES`, `SERVICE_MAX_RESPONSE_BYTES`, `SERVICE_MAX_TIMEOUT_MS`,
`SERVICE_MAX_INFLIGHT`, `SERVICE_MAX_DECLARATION_BYTES` and `SERVICE_MAX_DESCRIPTOR_BYTES`. A route path
(an operation's `path`, a binding's `endpointPath`) starts with `/`, has no empty, `.` or `..` segment and no
trailing `/`. The same schema check is available without writing a file: `stitchwire config validate service <path>`.

The metadata does not grant access, select a Unix socket or allow an arbitrary remote path.
Agent policy stores the owner `descriptorPath`; broker and target replicas grant service-wide reads
or exact operations.
Owner clients may wrap a `WireServiceError`; delivery certainty remains on the typed cause and
must not trigger replay when it is `unknown`.

The SDK takes Stitchkit and Zod from the consumer as peers (the supported ranges are in its package manifest): its schemas are handed to Stitchkit, so both must be the consumer's one copy. Stitchkit owns Unix I/O, contract stream
framing/terminal validation and pull-driven response bodies. Wire adds routing credit, cancellation
and total transport budgets without parsing the owner's domain frames.
Wire owns protocol decoding and failure mapping; it never starts a daemon. Internal framework
types do not leak into the public declarations. Packed NodeNext checks run without skipLibCheck.

- `call({ to, argv, stdin?, timeoutMs? }, { signal? })`: complete typed result, including refusal and `transportCause`.
- `status({ signal? })`: roster, declared profiles and local runtime health; no polling. A lane that
  is not connected carries `lastFailure` — the transport message, its timestamp and whether it is
  terminal. The client requires the complete runtime observation of its own door revision, including logical
  event readers and separately sampled lane handle counts; a mixed client/runtime
  revision fails explicitly.
- `peerObservation({ to, route?, mode? }, { signal? })`: native observation or explicit outcome.
- `publish({ topic, bootId, seq, data, observedAt?, cursor? }, { signal? })`: acknowledgement; disconnected lanes receive bounded pre-dispatch grace.
- `stream({ to, profile, args?, stdin?, cursor?, timeoutMs? }, { signal? })`: lazy `WireFeed`.
- `subscribe({ topic, resume?, lifecycle? }, { signal? })`: lazy `WireFeed`, no implicit SDK reconnect/resync.
- `close()` / `Symbol.dispose`: abort all active work and close idle connections.

`WireFeed` is an async iterator with `close()`. Start reading with `next()` or `for await`.
It permits only one pending `next()`. Breaking the loop, `return()`, abort or client close
releases the socket, including while waiting on a quiet topic. `close()` is synchronous;
await a pending read's rejection or `return()` when cleanup completion matters.

```ts
const feed = wire.stream({ to: 'worker', profile: 'declared-logs', timeoutMs: 30_000 });
for await (const item of feed) {
  if (item.kind === 'chunk') console.log(new TextDecoder().decode(item.data));
  else if (item.kind === 'error') console.error(item.frame.failure, item.frame.refusal);
  else console.log(item.frame.reason, item.frame.cursor);
}
```

Stream items are `chunk | end | error`; event items are `event | gap | error` and,
when requested with `lifecycle: true`, `subscription`. The item TYPE follows that option:
without it `subscribe` returns `WireFeed<EventFlowItem>`, so a data-only reader has no
`subscription` case to write and a member added to the full union does not move its
exhaustive `switch`. The narrowing applies only where the option's value is known at the
call site — a `boolean` variable or a whole `SubscribeRequest` value widens to
`WireFeed<EventItem>`, because narrowing those would be a claim about runtime the call
site cannot support. A `subscription` frame arriving on a feed that did not request one
is refused as `invalid-response` rather than delivered.
Each preserves its validated `frame`. Payload items additionally expose decoded `Uint8Array`
`data`. A gap, including `nextBootId`, is delivered to the consumer. The owner decides when
and how to fetch a snapshot or resume a durable journal; this package does not invent it.

`subscribe` validates continuity across frames with constant memory for the topic's single
declared producer. A fresh feed anchors at its first observed sequence, not necessarily zero.
A resumed feed starts after its supplied cursor. Range gaps account for missing sequences;
resume uncertainty at or behind the cursor does not move it. A boot-change names the only
allowed successor; its old range is broker high-water, not delivered position. Old-boot tail
may arrive from another lane until the successor begins. A named successor can be empty or
start mid-epoch. Duplicate/skipped events, changed producer/subscription and unnamed boot
changes throw `invalid-response`. The SDK does not reconnect, replay or fetch owner state.

The current SDK requires `failure`, `refusal`, `retryAfterMs` and nullable `transportCause` on
refusal-bearing wire envelopes and rejects missing or contradictory classifications.
`transportCause` is the shared machine
classification for route loss; raw-door clients branch on it rather than parse `detail` text.
See the source checkout's `docs/architecture/client-composition.md` for the two owner-client
recipes and `docs/architecture/sdk-adoption.md` for the exact distribution procedure.

## Broker health, contracts, topic helpers and drop-in declarations

- **Broker `/health` reader:** `brokerHealthUrl(laneUrl)` converts `ws://`/`wss://`/`http://`/`https://` lane URLs to `/health` under the one lane rule the agent and enrollment apply: no credentials, query or fragment, and plain `http:`/`ws:` only to loopback (`127.0.0.0/8`, `::1`, `localhost`), so `readBrokerHealth` does not read a remote broker over plain text. `readBrokerHealth(laneUrl, options?)` performs a bounded GET (`8s` default timeout, `8 MiB` default cap, `redirect: 'error'`, strict UTF-8) validated by `BrokerHealthSchema`; a body that is not JSON is `invalid-response` with the parse error as its cause. A broker of an earlier release that writes no `transport`, `application`, `bundle` or `admission` block is read without it: those fields are optional in `BrokerHealth`.
- **Browser-safe contracts (`@stitchwire/client/contracts`):** zero `node:*`, `stitchkit`, `process` or `Buffer` dependencies — exports forward-compatible Zod readers of `/status` and `/health` (`StatusResultSchema`, `BrokerHealthSchema`, `AuditStatusSchema`, `LaneStatusSchema`, `FleetNodeStatusSchema`, `FleetEditionStatusSchema`, `FleetConfigStateSchema`), `PeerResultSchema` (it drops fields it does not know, while its values stay closed), authoring schemas (`ServiceDeclarationSchema`, `TopicDescriptorSchema`, `TopicProfileSchema`, `ServiceBindingSchema`, `ServiceDescriptorSchema`), failure code enums (`ClientErrorCodeSchema`, `ServiceFailureCodeSchema`) and pure helpers (`brokerHealthUrl`, `parseServiceDeclaration`, `parseTopicDescriptor`, `isTopicInNamespace`, `isTopicAuthorized`).
- **Error chain inspection:** `extractWireServiceError(error)` and `extractWireClientError(error)` walk `.cause` safely — cycle-guarded, 16 links deep by default (the outermost error included; the optional second argument changes it), ignoring `AggregateError.errors`, matched by `instanceof`, so an error from a second copy of the package is not recognised, and never throwing: a link whose property or prototype traps throw ends the walk with no match; `wireErrorCode(error)` returns `{ source: 'service' | 'client', code }` of the nearest one — the two code spaces overlap (`timeout`, `cancelled`, `unavailable`, …), and `source` tells a service's refusal from a local failure.
- **Local path discovery:** `defaultConfigDir(options?)`, `defaultStateDir(options?)`, `defaultWireSocketPath(options?)`, `defaultNodeConfigPath(options?)`, `defaultServiceDropInDir(options?)` and `defaultEventDropInDir(options?)` resolve the one layout Stitchwire installs on macOS and Linux — `<home>/.config/stitchwire/node.json` and `<home>/.local/state/stitchwire/agent.sock`, a system unit included (pass its user's home as `homeDir`). There is no second, system-wide door such as `/run/stitchwire/wire.sock`: a unit that serves the door elsewhere names that path as `agentSocket` in its `node.json`, and its consumers pass the same path as `socketPath` (or `STITCHWIRE_AGENT_SOCKET`). `STITCHWIRE_AGENT_SOCKET`, `STITCHWIRE_STATE_DIR` and `STITCHWIRE_CONFIG_DIR` are read at call time, verbatim, and must be absolute paths (a relative one is a `RangeError`: it would resolve against each process's own working directory); an empty one counts as unset. An agent whose `node.json` names another `agentSocket` is reached only there. Only a file named `node.json` has default drop-in directories (`services.d/`, `events.d/` beside it). This package never reads `node.json` or broker tokens.
- **Drop-in declarations without touching `node.json`:** `writeServiceDeclarationFile`, `removeServiceDeclarationFile`, `writeTopicDescriptorFile` and `removeTopicDescriptorFile` validate the owner's value against the agent's exact schemas and atomically write it as given (no defaults filled in) as a `0600` file in the `services.d/` or `events.d/` directory. A directory the SDK creates is `0700`; an existing one is used as it is and must be owned by the writer and not writable by group or others, or the write is refused; the agent reads it on its next poll, with no `node.json` edit and no restart. Requirements: an agent of runtime 0.57.0 or newer (an older one reads no drop-in directory); the writer runs as the agent's user (the agent reads only files owned by its own uid and writable by nobody else); a `node.json` that sets `services.dropInDir`/`events.dropInDir` must be matched by passing `dropInDir`; `dropInDir` and `configPath` must be absolute paths (a relative one is `invalid-request`). A written file is not yet a loaded declaration: confirm it in `status()` — `services.declarations.descriptors` / `events.declarations.descriptors` list each file by `path` with its `state`, and `refused` names one the node will not serve. Failures: `invalid-request` (bad name or value), `limit` (size), `permission` (access denied, or a directory/file the agent would refuse), `transport` (any other filesystem failure: no space, read-only filesystem, I/O).

## Node identity

A node's id is answered without reading `node.json`, which holds the node's broker tokens. On the
machine: `(await wire.status()).nodeId`. From another machine, run the CLI there (over SSH):
`stitchwire status --json` prints the running agent's status, `nodeId` included; with the agent
stopped, `stitchwire config inspect node <path>` prints the file's `nodeId` with credentials as
digests only. Neither answer carries a token.

## Enrollment contract

`@stitchwire/client/enrollment` is a separate entry with the schemas and types of node
enrollment: node and admission requests, operations, phases, failure codes, material and the
result of `stitchwire enroll`, plus the request and result of a fleet operator's admission entry.
An orchestrator builds requests and parses results with these exports instead of a hand-written
copy, so a contract change surfaces at its type check rather than as `invalid-request` on the
target. It is contract only: no runtime, credentials or execution. The main entry does not
include it.

```ts
import { EnrollmentNodeRequestSchema, EnrollmentResultSchema } from '@stitchwire/client/enrollment';
```

## Quiet subscription readiness

```ts
for await (const item of wire.subscribe({ topic: 'example.changes', lifecycle: true })) {
  if (item.kind === 'subscription') {
    console.log(item.frame.subscriptionId, item.frame.subscriptionState, item.frame.lanes);
  } else if (item.kind === 'event') {
    console.log(item.data);
  } else if (item.kind === 'error') {
    console.error(item.frame.failure, item.frame.refusal);
  } else {
    console.log(item.frame.reason);
  }
}
```

`opening` proves local logical admission with no acknowledged broker lanes; `ready`
proves admission on the named lanes for this handle. HTTP headers/keepalive do not
confirm admission. Losing every acknowledged lane returns `opening`; a broker reconnect
ACK restores `ready` without a domain event. These transitions do not prove producer
presence, data freshness or domain validity. A consumer may clear an earlier transport
error on `ready`, never a payload error. Guard callbacks by the consumer's own generation.

This observation requires runtime 0.39.2 or newer supporting Door 5. An unsupported
request fails explicitly; the SDK never retries without lifecycle. Broker/agent rollout
is coordinated by the operator before consumer adoption. Data-only readers need no change.

## Failure semantics

Remote refusal and command exit are **results**, not thrown local connection errors.
`WireClientError` describes local failures: `invalid-request`, `closed`, `capacity`,
`cancelled`, `timeout`, `unavailable`, `permission`, `transport`, `http`, `unsupported`,
`version`, `invalid-response`, `limit`, `unexpected-eof`.

Its `delivery` is `not-sent` or `unknown`. **Unknown does not mean failed execution.**
Especially after an unreadable publication acknowledgement, never blindly republish.
No method retries, falls back to CLI/SSH or silently converts failure into empty data.
`metadata` contains internal diagnostic context; do not forward it to an end-user UI.
Unary failures include `metadata.timing`: UTC start, monotonic elapsed/header time,
configured deadline, phase and caller-abort state. These describe the local attempt,
not proof of broker acceptance or an instruction to retry.

Readers ignore additive object fields. A foreign version on versioned responses is a named
`version` error. Status carries the local door version; publication acknowledgement remains an
unversioned exact response. Malformed required fields fail explicitly, without replay.

The readers of `/status` (`status()`, `StatusResultSchema`) and `/health` (`readBrokerHealth`,
`BrokerHealthSchema`) and their parts (`AuditStatusSchema`, `LaneStatusSchema`, `FleetNodeStatusSchema`,
`FleetEditionStatusSchema`, `FleetConfigStateSchema`) also read an enumerated value they do not know
— written by an agent or broker of a newer release — as `unrecognized`. It is distinct from every
value a writer sends, `unknown` included, so an exhaustive `switch` over such a field has a case for
it, and a decision must treat it as unknown or failed, never as fine. These readers do not bound how
many nodes a list holds; the response body is bounded by bytes. Results of calls, streams,
publications and peer observations still refuse a value they do not know.

## Bounds and lifecycle

- Default RPC/stream duration 30s; explicit duration 1s–15min. Local total deadline allows
  10s for delivery of the remote terminal. Status uses the header/open timeout (default 10s).
- Publication deadline defaults to 30s and caps the whole response. Peer observation adds
  the native 2s observation bound to the open timeout.
- Data-only subscriptions have a header deadline. With `lifecycle: true`, `openTimeoutMs`
  bounds the first acknowledged broker lane, including time after HTTP headers. Once ready,
  quiet intervals have no inactivity deadline. Cancel explicitly.
- Default 32 active requests, configurable 1–256; excess requests fail without a hidden queue.
- Maximum JSON response 52 MiB (covers escaped bounded stdout/stderr); publication ack 16 KiB.
- Maximum NDJSON line 512 KiB, stream payload total 256 MiB. Limits can be reduced through
  `maxResponseBytes` and `maxFrameBytes`. The parser is pull-driven.

Typed item-framed streams use Stitchkit's strict newline and terminal completion policy.
Packed stalled-reader gates verify bounded backpressure plateaus (`2/512` and `6/512` frames) and
multi-megabyte continuous subscriptions (600 frames across 26 MiB on one request without a lifetime
cutoff) on both Bun and Node. No `node:http` streaming fallback, implicit replay or inactivity
workaround exists.

The SDK version is independent from the agent/broker release, but each SDK declares one exact local
door revision. Raw HTTP consumers must implement that same current contract. Node 22.3.0+ and Bun
1.4.4+; ESM only, not a browser transport.
