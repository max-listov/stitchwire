---
title: "ADR 0006: resume without a queue"
description: Answer a returning subscriber with the truth about what it missed, and keep at most a bounded in-memory ring of the topic's recent past.
type: decision
status: outdated
created: 2026-08-25
updated: 2026-09-04 15:46 +07:00
---

# ADR 0006: resume without a queue

> Historical record. Its protocol-version and compatibility claims were superseded by
> [ADR 0007](./0007-one-fleet-one-version.md); current architecture is authoritative.

## Context

ADR 0004 made the event plane deliberately volatile and left a named seam: a durable plane would
have to define message identity, retention, consumer offsets, redelivery, acknowledgement ownership
and compaction before choosing storage. `docs/VISION.md` listed durable delivery for a sleeping node
as direction, not as a feature.

The fleet this transport exists for has a laptop in it. Measuring the actual behaviour rather than
assuming it changed the size of the problem: loss after a reconnect was **not** silent — the merging
consumer inferred a gap from the sequence jump — but it arrived only with the next event and was
labelled `overflow`. A quiet topic could leave a woken machine believing nothing happened, and an
operator reading `overflow` would go raise a queue depth for a machine that had simply closed its
lid. Meanwhile the broker knew exactly how much had been missed and threw that knowledge away,
because `event:subscribe` carried no cursor and a reconnect was indistinguishable from a first
subscription.

## Decision

**A subscriber may state where it stopped, and the broker answers before any live frame.**
`event:subscribe` carries `resume: { bootId, afterSeq } | null`. The answer is a gap over the exact
missing range, retained frames, both in that order, or nothing when continuity is proven. Silence is
reserved for the two cases where continuity really is proven: the cursor is the broker's next
sequence, or it is ahead of this broker's view entirely, which is ordinary on a second lane.

**Retention belongs to the topic, is opt-in, and lives only in memory.** A topic may declare
`retain: { maxAgeMs, maxBytes }` in broker config — both bounds or neither. One shared ring per
topic, never a per-subscriber mailbox. It is dropped on a producer boot change and dies with the
broker process.

**Gaps name themselves.** `resume` and `retention` join `latest-wins`, `overflow` and `boot-change`,
because the repair differs: `overflow` means this consumer is too slow, the other two mean it was
away.

**The wire moves to protocol 3.** A new field on a `.strict()` envelope is as breaking as a new
version — the runtime drops a frame that fails its schema without a word — so the field costs a flag
day either way and it is taken deliberately in one.

**The catch-up contract is named rather than hidden.** On a gap the consumer takes a snapshot
through the RPC plane and returns to living on events. That was already what consumers did; writing
it down is what turns it from a workaround into a contract, and it is why retention windows are
sized in seconds and minutes.

## Why the alternatives were rejected

- **Broker persistence on disk.** It makes the router stateful across its own restarts and starts
  promising delivery, which is the queue ADR 0001 refused. An in-memory ring promises nothing beyond
  the process and reports its own death as an ordinary gap.
- **Per-subscriber offsets held by the broker.** This is the mailbox: it introduces cost for an
  absent node, and with it a bound on absence, a notion of a dead subscription, and accounting for
  machines that may never return. Retaining per topic makes all three questions disappear rather
  than answering them.
- **A separate idempotency key in the envelope.** Within a producer boot the identity is already
  `(topic, bootId, seq)`, replay hands back the identical frames, and the merging consumer already
  deduplicates by it. Across a boot only the publisher's domain knows what "the same event" means,
  and it has an opaque payload for that. A field the transport never reads does not belong in the
  transport's envelope.
- **A third retention bound by event count.** `maxEventBytes` already caps one event, so a count
  would defend nothing that bytes do not. Age and bytes each answer a distinct failure: value
  decaying, and one loud topic evicting every other.
- **Retention on `latest-wins` topics.** Coalescing says only the newest value matters; replay says
  the ones before it do too. The configuration is refused rather than silently resolved.

## Consequences

- Mixed protocol 2 and 3 peers do not coexist. Rollout is a flag day for the whole fleet, and the
  mixed-version harness must prove a mixed pair **refuses**, not that it interoperates.
- A returning subscriber may see the same `(topic, bootId, seq)` twice — delivery is at-least-once
  once catch-up exists — and drops the duplicate with the identity it already has.
- `/health` gains per-topic retention: declared window beside actual occupancy.
- The audit records `resumeFrom` on every subscription, so a reader can tell a new consumer from a
  laptop closing its lid again.

## Still not done, deliberately

Surviving a broker restart. That is the real durable plane — disk, acknowledgement ownership,
compaction — and ADR 0004's seam stays open for it. What is built here is the honest half: the
transport now knows what it lost and says so.
