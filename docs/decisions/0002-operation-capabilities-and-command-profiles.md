---
title: "ADR 0002: operation capabilities and node-owned command profiles"
description: Why broker authority is operation-scoped while executable authority remains a constrained profile owned by the receiving node.
type: decision
status: outdated
created: 2026-08-21
updated: 2026-09-04 15:46 +07:00
---

# ADR 0002: operation capabilities and node-owned command profiles

> Historical record. Its protocol-version and compatibility claims were superseded by
> [ADR 0007](./0007-one-fleet-one-version.md); current architecture is authoritative.

## Context

Pair-only RPC ACLs answer who may reach a node, but not what transport operation was granted. A
string allowlist fixes the executable while leaving the rest of argv and stdin caller-controlled.
That is sufficient for a purpose-built narrow executable, but it cannot safely expose one command
of a broader CLI without a wrapper and cannot state runtime budgets beside the authority.

## Decision

Broker grants are triples of caller, operation and target. The operation vocabulary is `rpc`,
`stream`, `publish` and `subscribe`. This decision introduced the non-RPC names as default-deny
foundations; ADR 0003 and ADR 0004 define their later transport semantics. They are never implied
aliases for RPC.

The receiving node owns a named command profile containing an absolute executable, fixed base argv,
an explicit caller-argument policy, stdin policy, cwd, inherited/fixed environment, maximum timeout,
per-stream output cap and concurrency. The broker never interprets these profiles. The node validates
the complete request and admits execution immediately before it creates a process.

All envelopes and process resources are bounded. Broker and node admission are independent. A
timeout signals the process group, then force-kills that same group after a bounded grace period.
Audit stores command name and byte/count metadata, never full argv or stdin, and reports asynchronous
write failures through broker health and stderr.

## Compatibility

- Legacy broker `acl` entries normalize to `rpc` grants only.
- Legacy node `name → absolute binary` entries normalize to the prior caller-argv/stdin authority,
  with explicit global ceilings. Operators can migrate one command at a time to constrained objects.
- One or two broker digests may be configured for a node, allowing a bounded token-rotation overlap.
  More than two is invalid. Rotation still requires ordinary config distribution/reload operations;
  this decision adds no distributed coordinator.
- Protocol version remains `1`: RPC invocation and result envelopes are compatible, with tighter
  validation only for previously unbounded payloads.

## Rejected alternatives

**Broker-owned command policy.** It would make the router an authority over execution and let a
broker mistake widen what a node runs. The machine bearing the consequence keeps the final gate.

**Shell templates.** Quoting a partly fixed command string recreates injection as a configuration
language. Profiles remain argv arrays and never spawn a shell unless the operator explicitly names
a shell binary and fully fixes its arguments.

**A new durable or multi-broker transport.** Capability names are not delivery semantics. Storage,
replay and broker coordination require their own state models and are outside this boundary.
