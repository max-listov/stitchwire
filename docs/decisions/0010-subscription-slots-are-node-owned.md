---
title: "ADR 0010: subscription slots are node-owned"
description: Three ceilings with three owners bound event subscriptions; the one that decides whether a consumer can subscribe belongs to the node, not the broker or the topic.
type: decision
status: accepted
created: 2026-09-01
updated: 2026-09-05 19:34 +0700
---

# ADR 0010: subscription slots are node-owned

## Context

An event subscription costs something on three machines at once: the consumer's process holds an
iterator, the node holds a delivery lane, and the broker holds a per-topic fan-out slot. A single
ceiling cannot express that. Whichever machine owns the number, the other two get a limit chosen by
somebody who cannot see what they are carrying.

The failure that settled it was not a capacity problem. A local consumer that walked away without
closing its subscription left the node's slot taken: `ndjsonRoute` announces departure by aborting
the request's signal **and** by calling `return()` on the iterator, and a generator parked inside
`await source.next()` — which is where a subscription to a quiet topic spends its life — cannot be
reached by the second. The measurement was **32 held slots against 8 live consumers** on one node,
and **1251 refusals across four nodes** while the topic's own ceiling was never touched.

That is the shape of the decision: the broker's counters were healthy and truthful, and the fleet
was still refusing subscribers. Whoever answers "can this consumer subscribe" must be the machine
whose resource is exhausted.

## Decision

Three ceilings, three owners, and each one refuses for its own reason.

| Ceiling | Owner | Bounds |
|---|---|---|
| `maxEventSubscriptions` | **node** | logical readers, including readers waiting for offline lanes |
| `maxEventSubscriptionsTotal` | **broker** | subscriptions across every node it serves |
| `maxSubscribers` | **topic** | fan-out width of one topic |

A refusal names which ceiling refused. An operator reading `capacity` therefore knows which number
to raise, and raising the wrong one is visibly ineffective rather than quietly ineffective.

A logical lease is acquired before opening a local queue or a resilient broker iterator. Two
brokers carry one logical reader; reconnect does not acquire another logical lease. Each lane
retains the same ceiling as a derived local resource bound, also protecting standalone lane use.
Broker total and topic fan-out limits remain independent.

The logical lease is released once all child iterators and the passive local queue are closed:
after terminal broker sources, explicit return, caller departure or node drain. Admission is
stopped before drain starts. The passive local source cannot keep a terminal broker refusal alive.
A quiet topic remains open; absence of events does not imply consumer departure.

Status derives logical count, reader IDs and per-topic totals from the same live handles. Each
lane reports its own timestamped local handle count and connection state. A disconnected lane's
zero handles do not mean that its logical readers disappeared or that broker state is known.
Reader IDs identify runtime subscriptions, not processes or authenticated applications.

## Rejected alternatives

**One ceiling on the broker.** It is the machine that can see the whole fleet, and it is the machine
that cannot see a node's memory or a leaked local iterator. The incident above is precisely a state
the broker reports as healthy.

**A per-topic ceiling only.** Topics are declared by their producers; the cost of a subscription is
paid by the subscriber's node. A number set by the producer would bound a resource it does not own.

**Timing a subscription out.** Silence is a topic's normal state, so a subscription that ended
itself for being quiet would turn "nothing happened" into a fault. What does exist is
`subscriberIdleMs`, which ends a subscription whose deliveries are not acknowledged — the broker can
distinguish a slow subscriber from a quiet topic; the node cannot.

## Consequences

- Three numbers to configure instead of one, and an operator must know which is which. The refusal
  reason is what makes that knowable without reading this document.
- A node's ceiling is reached before the broker's in normal fleets, which is intended: the machine
  bearing the cost refuses first.
- Slot accounting is only as good as its release path. That path is one frame and one signal, and
  both are tested against a consumer that leaves without closing.

## Revisit when

A consumer appears whose subscriptions are held by something other than a live local iterator — a
durable or resumable subscription that outlives the process holding it. The node's slot then stops
being the right unit, because the resource it bounds is no longer the thing being consumed.
