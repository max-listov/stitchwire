---
title: Credit-based volatile streams
description: Route live profile output with explicit byte credit and producer-owned resume cursors, without broker payload storage.
type: decision
status: outdated
created: 2026-08-21
updated: 2026-09-04 15:46 +07:00
---

# Credit-based volatile streams

> Historical record. Its protocol-version and compatibility claims were superseded by
> [ADR 0007](./0007-one-fleet-one-version.md); current architecture is authoritative.

## Decision

Add a live `stream` operation to protocol version 1 using six typed events:
`open`, `chunk`, `window`, `cancel`, `end` and `error`. The broker owns admission, participant
identity, sequence and credit accounting. It stores only bounded live metadata and never stores a
chunk. The receiving node starts only a configured stream profile. The local consumer reads NDJSON
from the existing `0600` Unix socket.

Backpressure is receiver-driven byte credit. A producer cannot emit before a window or beyond its
remaining credit; credit is replenished only after the local iterator consumes a chunk. Exhausted
credit starts a slow-consumer deadline. Every terminal path removes registry state and propagates
cancellation to the detached producer process group.

Resume is allowed only for an NDJSON producer profile that declares stable cursors and supplies one
with each chunk. A requested cursor is passed to that producer as bounded process environment; the
broker does not interpret it. Raw and cursorless profiles return `unsupported`.

## Why

Socket transport flow control alone does not state application memory ownership: a fast producer
can outrun a slow local reader while every individual frame remains valid. Explicit credit makes
the maximum outstanding payload a protocol invariant and lets each hop fail closed.

Broker replay would quietly turn a live router into a storage system with retention, duplicate and
recovery semantics. A producer cursor instead points back to the producer's own source of truth and
does not claim durability the wire does not have.

## Compatibility

Protocol version remains `1`: existing RPC envelopes and events are unchanged. Legacy pair ACL is
still normalized to `rpc` only, so upgrading grants no stream authority. Existing node configs gain
empty `streams` and bounded stream admission defaults. Agent/package version becomes `0.4.0`.

## Rejected here

- durable broker queues, replay logs or delivery acknowledgements;
- NATS, JetStream or another broker topology;
- multiple coordinated brokers;
- arbitrary executables, shell strings or caller-selected paths;
- domain-specific event types.
