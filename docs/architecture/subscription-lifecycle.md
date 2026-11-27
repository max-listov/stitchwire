---
title: Quiet event reader lifecycle
description: Confirmed admission of a specific handle, independent of domain events.
type: architecture
status: active
created: 2026-09-09 08:49 +07:00
updated: 2026-10-17 14:43 +07:00
---

`subscribe({topic, lifecycle: true})` requests control frames in the same pull-driven
feed. It is a choice to observe the transport lifecycle, not a different transport and not a fallback.
Without this field the stream contains only event/gap/error, and since SDK 0.10.0 the TYPE
itself says so: a subscription without `lifecycle` yields `WireFeed<EventFlowItem>`, a union of
three kinds, and with `lifecycle: true` the full `WireFeed<EventItem>`. The type narrows only where
the option's value is known at the call site: a `boolean` of unknown value and a whole
`SubscribeRequest` widen to the full union, because narrowing them would lie about what may
arrive. The guarantee does not rest on an agreement with the runtime:
a control frame that arrives in a feed that did not ask for it is refused as `invalid-response`.
SDK 0.10.0 and runtime 0.39.2 support this request on Door 5; a runtime without support
rejects the unknown field. The SDK does not repeat the request without lifecycle and does not
replace a refusal with success.

## States and evidence

| Signal | What is proven |
|---|---|
| HTTP 200 / empty line | The local HTTP door answers; admission is unknown |
| subscription / opening / lanes=[] | This logical handle received local admission; there are no confirmed broker lanes |
| subscription / ready / lanes=[…] | The handle is admitted locally; the named lanes confirmed admission of its upstream |
| error | Terminal refusal of the current handle |
| WireClientError | Local timeout, transport failure, invalid response or cancellation |

Every control frame contains `subscriptionId`, `topic`, `subscriptionState`, `lanes`
and Door `v`. The logical ID is stable across broker reconnects; a new SDK subscription has a
new handle. The SDK refuses an ID change even if the topic matches. A broker lane UUID
is not presented as the logical identity; the node combines independent ACKs by configured lane ID.

Losing the last confirmed lane yields opening; a reconnect ACK returns ready
without a domain event. While a second lane is alive the state stays ready with its name.
Local delivery does not confirm broker admission. Ready does not prove the presence of a
producer, data freshness, a running domain runner or the absence of gaps.

The open timeout applies until the first ready. After it, the runtime retries lost
broker subscriptions with bounded backoff, and the consumer receives the state changes.
The SDK introduces no separate reconnect timeout; the consumer may cancel its handle.
`next()` starts the feed lazily; `return()`, `close()`, an external AbortSignal and client
close end it. Cancellation of a pending read is rejected with `code=cancelled`,
and the runtime releases the logical lease. Lane handles are released with the last upstream reader.

## Shared live upstreams

Within one node runtime instance, live readers (`resume: null`) of one topic share one upstream:
the local source plus a separate resilient subscription on every configured broker.
Identity, credentials and local policy are shared within this instance; the group is not reused
across the boundary of nodes or runtime instances. Both brokers remain active; the merge checks
producer boot/sequence, gaps and reconnect independently of the number of local readers.

Each reader holds a separate logical admission and UUID. `events.activeSubscriptions` and
`events.subscriptions` count readers; `lanes[].eventSubscriptions` counts physical subscriptions.
Topic/broker subscriber ceilings apply to upstreams from the node, local admission to applications.
A new live reader receives the group's current acknowledged state, so the first control frame
may be `ready` right away. Payload history is neither stored nor replayed. In-flight delivery
remains volatile: freshness and initial synchronisation are determined by the data owner.

A request with a non-null resume always gets its own upstream and broker answer, even if a reader
with the same cursor exists nearby. There is no shared replay cache and no mixing of history/live.

Each reader's queue is an ordered Stitchkit bounded channel with an item/byte ceiling. A slow
reader receives, after the accepted data, one terminal `denied/capacity`; its admission is released
immediately. The other readers keep receiving data, without waiting and without silent drop. The
consumer decides on resume/reconciliation itself. Cancelling a reader does not cancel its neighbours;
the departure of the last one closes the local source, broker subscriptions and reconnect waits.
Drain also waits for a close that has already started.

Checks: `test/shared-event-source.test.ts`, `test/logical-subscription-budget.test.ts`,
`test/lane-compression.test.ts`: two SDK readers get different IDs and the same 12 events with
12, not 24, broker deliveries; plus partition/rejoin, quiet lifecycle and independent cancellation.

## Usage

```ts
const feed = wire.subscribe({ topic: 'example.changes', lifecycle: true });
try {
  for await (const item of feed) {
    if (item.kind === 'subscription') {
      console.log(item.frame.subscriptionId, item.frame.subscriptionState, item.frame.lanes);
      // Only ready may clear the previous attempt's transport error.
      // Payload validation/freshness remain separate owner state.
    } else if (item.kind === 'error') {
      console.error(item.frame.failure, item.frame.refusal);
    } else if (item.kind === 'gap') {
      console.log(item.frame.reason);
    } else {
      console.log(item.data);
    }
  }
} finally {
  await feed.return();
}
```

The consumer binds callbacks to its own generation: an old handle cannot clear the
error of a new attempt. A single `ready` is a fact of transition, not a perpetual health certificate.
Checks: `test/subscription-lifecycle.test.ts`, `test/client-subscription-lifecycle.test.ts`.
