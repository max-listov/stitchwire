---
title: "ADR 0005: independent multi-home broker lanes"
description: Remove the broker SPOF with simultaneous independent lanes, no leader and no uncertain command replay.
type: decision
status: outdated
created: 2026-08-22
updated: 2026-09-04 15:46 +07:00
---

# ADR 0005: independent multi-home broker lanes

> Historical record. Its protocol-version and compatibility claims were superseded by
> [ADR 0007](./0007-one-fleet-one-version.md); current architecture is authoritative.

## Decision

A node may hold one to eight explicitly named broker endpoints. Every endpoint has its own URL and
token and connects simultaneously. Lanes do not coordinate, replicate broker state or elect a
leader. The existing local Unix socket remains the only consumer door.

RPC and stream choose a connected lane before emit. A disconnected lane may be skipped, but an
envelope handed to a transport is never replayed on another lane: broker admission or execution may
already have happened. This preserves at-most-once dispatch under uncertainty.

Event publish sends the same author tuple `(topic, producer, bootId, seq)` to every healthy lane.
Local subscriptions exist on every lane and merge into one bounded queue. The merge deduplicates by
author sequence, suppresses covered gaps and accepts a new author boot only after the exact previous
boot-change marker. Broker-local subscription ids are rewritten to one local id. A reconnect is
live-only: a broker can attach at the current author sequence but never replays older payloads.

## Compatibility

Protocol remains `1`; package version becomes `0.6.0`. The disk boundary accepts the 0.5 single
`url`/`token` pair and normalizes it to lane `primary`. Runtime code sees only canonical `brokers[]`.
RPC, stream and event wire frames are unchanged.

## Failure semantics

- one lane down: RPC/stream select another; subscriptions continue; doctor reports degraded;
- emit handed down and acknowledgement lost: return transport/timeout, never replay;
- partial event admission: local publish succeeds with an explicit accepted-lane count;
- all lanes down: new calls fail generically, subscriptions remain bounded and await reconnect;
- broker restart: subscriptions reattach live and duplicate author frames remain suppressed.

## Rejected

- active/passive leader selection or a single preferred connection;
- broker-to-broker replication, consensus, shared storage or durable replay;
- retrying an uncertain RPC/stream with the same or a new id;
- deriving authority from another lane's credentials or policy.
