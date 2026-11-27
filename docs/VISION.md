---
title: Stitchwire
description: Generic broker-mediated transport for declared services, bounded streams and volatile events.
type: vision
status: active
created: 2026-08-18
updated: 2026-09-04 12:15 +07:00
---

# Typed transport between outbound-only nodes

Every agent dials out to one or more trusted brokers. Calls can travel in either direction over
those connections, so nodes behind NAT need no inbound network listener. Local applications use
one HTTP-over-Unix door, directly or through the optional typed client.

Wire owns identity, routing, grants, bounds, cancellation and transport delivery certainty.
Services own their schemas, collection, freshness, durable journals, cursors and business rules.
A descriptor is projected from the owner's Stitchkit contract, states available operations and
never grants a caller permission by itself. Service streams reuse the same bounded delivery machine
as profile streams while leaving domain frames, terminal semantics and cursors with the owner.

The product has two distribution artifacts: a Bun runtime bundle containing broker/agent/CLI,
and an independently versioned Node/Bun client. Shared schemas are an internal source boundary.
No private companion, neighboring repository or hosted control plane is needed to build or run it.

## Deliberate limits

- Brokers are trusted and can see routed payloads and authentication tokens. Hashes protect the
  stored credential registry, not the authentication exchange. Network deployments require TLS.
- Unix socket access grants machine-local authority, not application end-user authorization.
- Fixed command profiles are optional constrained execution, never a caller-selected shell.
- Event retention is bounded and volatile. Gaps require owner-controlled reconciliation; no
  exactly-once, durable broker history or automatic safe retry is promised.
- Brokers and agents require the exact same runtime release. Coordinated upgrades may interrupt
  traffic. The client/door lifecycle is separate and exact; rolling mixed-runtime upgrades are not
  supported.
- Public readiness is a validation target, not permission to publish. Domain reads use declared
  services; embedded domain readers and compatibility dispatch are outside the product boundary.
