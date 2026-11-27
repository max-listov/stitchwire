---
title: Compose owner clients without domain knowledge in transport
description: Fetch and invocation recipes preserve correlation, cancellation and delivery outcomes.
type: architecture
status: active
created: 2026-08-30
updated: 2026-10-17 14:31 +07:00
---

## Ownership

The owner exports domain schemas, a typed client and non-authorizing composition metadata.
The application supplies an operator-selected target and one shared local Wire client. Agent
bindings and broker grants authorize service-wide reads or exact operations; a descriptor never
grants permission. The descriptor is projected from the same Stitchkit contract rather than a
second manually maintained operation catalogue.
Wire does not interpret the JSON payload or rewrite an owner request ID inside it.
The descriptor carries each static JSON POST route derived from the contract. A binding therefore
has no second prefix or operation-to-path registry to drift.

## Fetch-shaped client

```ts
const api = createOwnerClient({
  baseUrl: ownerComposition.baseUrl,
  fetch: createServiceFetch(wire, { to: target, ...ownerComposition }),
});
```

`createOwnerClient` and `ownerComposition` are supplied by the owner, not Wire exports.
`createServiceFetch` reads request bodies only through the declared byte ceiling on virtual POST routes.
A Stitchkit operation whose parsed input is an empty strict object produces no HTTP body; the adapter
encodes that absence as the single JSON document `{}` for both unary and stream dispatch. An explicitly
supplied empty string remains invalid at the generic Wire request boundary. Unary endpoints return
buffered JSON responses; Stitchkit contract-stream endpoints receive a pull-driven Response
over Wire's existing credit/cancel delivery machine. Stitchkit remains the only parser and owns
data/error/end validation, explicit completion and truncated-EOF semantics.
It rejects arbitrary origins, paths, query strings and oversized bodies before dispatch.
Wire refusals throw `WireServiceError` with the original refusal, retry hint, transport cause,
diagnostic and delivery certainty; actual owner HTTP status/payload becomes a Response.
An owner client wrapping errors must preserve `cause`. Never turn an exception into HTTP200.

## Invocation-shaped client

Supply the owner's invocation port with a function of this shape, using its exact signature:

```ts
async function invoke(operation: string, payload: string, signal?: AbortSignal) {
  const { outcome } = await wire.invokeService({
    to: target, service: descriptor.service, revision: descriptor.revision,
    operation, payload, timeoutMs: operationTimeoutMs,
  }, { signal });
  if (outcome.status === 'failure') throw new WireServiceError(outcome);
  return { status: outcome.httpStatus, body: outcome.payload };
}
```

The owner validates the returned body and its domain request ID. Transport correlation is
independent. Each promise carries its own result/cause; never use a mutable shared last-error
slot to connect concurrent requests. `response/received` is receipt, not domain success.
Invalid domain data remains a received invalid owner response, never `not-dispatched`.

## Owner ingress

The node delivers a call to the owner as one POST of the envelope `{v, id, caller, service, revision,
operation, payload}` to the binding's `endpointPath`. `createServiceIngress({ descriptor, handler })`
is the owner's single implementation of that door: it reads the envelope up to the widest request
ceiling its descriptor declares, parses it with the same strict schema the node writes, and calls the
owner's Stitchkit handler with `POST <operation path>` and the payload as the body.

```ts
const ingress = createServiceIngress({ descriptor, handler: createHandler({ services }) });
Bun.serve({ unix: socketPath, fetch: ingress });
// in an endpoint, authorize or beforeHandle: serviceCaller(context)?.caller
```

An envelope the descriptor does not declare is answered HTTP 400 `{"error":"invalid-request","detail":"…"}` before
the handler runs: another service or revision, an unknown operation, a version other than 1, a body that
is not JSON, a payload past the operation's `requestBytes`, an envelope past the descriptor's ceiling.
The node still checks every call against the descriptor and grants it serves by; the helper repeats
only what the owner needs to parse the envelope safely.

The caller is not carried in a header. It is attached to the `Request` the helper builds through Stitchkit's
`defineRequestIngress` channel, and `serviceCaller(context)` reads it back from the endpoint context, so a header sent to the handler through another door, or a copy of a delivered
request, carries no caller. The node's cancellation of the owner request is the `signal` of the forwarded
one. The protocol of the door does not change, and an owner that parses the envelope itself keeps working.

## Outcomes and lifetime

| Observation | Meaning | Consumer responsibility |
| --- | --- | --- |
| Service failure | typed code, delivery, retryAfterMs, transportCause | preserve all fields; never branch on prose |
| Local exception | WireClientError with local delivery certainty | no blind retry of unknown execution |
| Stream end | explicit reason, including timeout or cancellation | interpret reason; end does not imply completed |
| Stream/event error | failure, refusal, transportCause, retry hint and terminal reason where present | no string matching or producer-error flattening |
| Event gap | explicit transport discontinuity | owner-controlled recovery |
| EOF without terminal | unexpected-eof exception | not a successful completion |

Caller cancellation covers body consumption. Quiet subscription lifetime is not bounded by
the header deadline; close/return/abort when finished. Existing Kit contract-stream cleanup and
Unix transport supply the streaming primitives. `createBoundedAdmission.run` separately bounds
finite work, retaining its lease until actual work settles even when the caller stops waiting;
it is not a drop-in scope for a returned live iterator. No new framework API is required here.

One-shot publishers may use a fresh boot with sequence0 per invocation. A long-lived publisher
owns its boot and monotonic sequence, admission and delivery policy. The CLI creates a fresh
identity for each call; the agent does not allocate a persistent publisher sequence on its behalf.

## Executable evidence

`test/fixtures/client-composition.mjs` runs the published SDK entrypoint and Stitchkit typed
client against a synthetic Unix door on both Bun and Node. It checks concurrent correlation,
denied/capacity/offline/unknown, HTTP status, malformed owner output, bounds and cancellation.
`test/fixtures/client-empty-service.mjs` proves that an installed package carries `{}` for actual
empty-input Stitchkit unary and stream operations on both runtimes.
`test/fixtures/client-service-ingress.mjs` runs the packed `createServiceIngress` in front of a real
Stitchkit handler on both runtimes: the caller arrives, a foreign envelope does not.
`examples/service/run.ts` separately executes a real owner handler through two brokers and
agents, including policy no-dispatch. Both are required: injected composition alone is not
proof of broker authorization or an installed application's acceptance.
