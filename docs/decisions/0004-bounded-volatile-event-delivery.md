---
title: "ADR 0004: bounded volatile event delivery"
description: Use declared topics, independent operation capabilities and explicit gaps without implying durable replay.
type: decision
status: outdated
created: 2026-08-21
updated: 2026-09-04 15:46 +07:00
---

# ADR 0004: bounded volatile event delivery

> Historical record. Its protocol-version and compatibility claims were superseded by
> [ADR 0007](./0007-one-fleet-one-version.md); current architecture is authoritative.

## Decision

Add `subscribe`, `unsubscribe`, `publish`, `event`, `gap` and `error` frames additively to protocol
version 1. Broker config owns exact topic declarations: producer, subscriber allowlist, delivery
mode and budgets. Node config independently narrows the local Unix publish/subscribe surface.

Publish and subscribe require separate capabilities. A producer receives `publish` toward itself;
a subscriber receives `subscribe` toward the producer. Legacy pair ACL continues to grant `rpc`
only. Authenticated node identity overrides all participant claims in envelopes.

Each producer boot starts at sequence zero and owns one authenticated connection. Each subscription
has an independent bounded queue and delivery-ack timeout. Latest-wins coalesces pending events;
ordered mode reports bounded overflow. Both expose exact `gap` ranges. A slow subscriber is removed
without delaying another subscriber.

Cursor and `observedAt` are opaque provenance. Subscribe carries no cursor and the broker sends no
current/latest value on join, so reconnect cannot be mistaken for replay.

## Compatibility

The change is additive: protocol remains `1`, while package/agent becomes `0.5.0`. Existing broker
and node configs normalize to no topics and no local event authority. RPC and stream contracts and
their legacy migration remain unchanged.

## Rejected here

- broker persistence, retained values or reconnect replay;
- delivery acknowledgements that imply durable processing;
- NATS, JetStream or another broker/storage layer;
- multi-broker replication;
- domain-specific topic schemas or adapters.

## Durability seam

A future durable plane must define message identity, retention, consumer offsets, redelivery,
acknowledgement ownership and compaction before choosing storage. It must not reinterpret volatile
cursor provenance or gap frames as durable offsets.
