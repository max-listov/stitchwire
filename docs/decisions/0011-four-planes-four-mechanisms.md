---
title: "ADR 0011: four planes are four mechanisms, and command authority is per command"
description: Why the call plane stays beside the service plane, and why the broker grant that authorised it was split into a peer grant and a per-command grant.
type: decision
status: accepted
created: 2026-09-01
updated: 2026-09-04 12:15 +07:00
---

# ADR 0011: four planes are four mechanisms, and command authority is per command

## Context

An audit asked whether the door's four planes are four ways of doing one thing. Two of them look
almost identical from the caller's side: `/wire/call` and `/wire/services/invoke` both take a named
operation on a named node and return one answer. The proposal was to fold the first into the second
as a second kind of service binding.

The premise did not survive reading the code, and it failed twice:

- **The mechanisms differ on the target, not the caller.** `/wire/call` **spawns a process** the
  node declares; a service **proxies to a server that is already running** — `ServiceBinding`
  carries `socketPath` and `endpointPath`. A node that wants to answer one three-second question
  would have to keep a daemon alive to do it.
- **Consumers do use the generality.** Nine of seventeen profiles on the live fleet declare
  `callerArgs: append`, and callers pass real arguments (`--cursor`, `--limit`, `--after`). The
  reading that they all invoke a bare name was wrong.

Folding would also have traded away properties the service envelope has no room for: the exit code,
`stderr`, `truncated`, a 900-second deadline against the service plane's 30, four megabytes of
answer against one, and both per-caller rate limits.

What the audit did find, and what mattered, was elsewhere: the broker grant that authorised command
execution was `{ operation: 'rpc', targets: ['*'] }` on the live fleet, while `subscribe` and
`stream` beside it were addressed. The router could not distinguish "take a monitoring snapshot"
from "run anything on any node" — and `rpc` also gated peer round-trip observation, an unrelated
question wearing the same name.

## Decision

**The four planes stay, and the boundary between them is the mechanism, not the call shape.**

| Plane | Mechanism |
|---|---|
| `/wire/call` | spawn a declared command, one answer |
| `/wire/stream` | bounded delivery machine for a declared process or service response |
| `/wire/services/invoke` | proxy to a running local server, one unary answer |
| `/wire/events/*` | volatile fan-out |

**Command authority becomes per command.** `commandGrants` names `{caller, targets, command}`.
Targets may be `*`, because a roster changes; the command may not, because a grant that cannot name
the operation cannot be read as authorising one.

**`rpc` is renamed `peer`** and keeps only what it always also did: authorising round-trip
observation between two nodes.

**The bare-path profile form is retired.** `name → /absolute/binary` expanded into a profile with
caller arguments at the maximum, a megabyte of stdin, a fifteen-minute deadline and a concurrency of
128 — "run what I give you", which makes a per-command grant a sentence with no content. The
capability is unchanged; a command must now declare what it allows.

**Commands gain what folding was supposed to buy.** `output: {mode:'json'}` has the node validate
stdout before answering, and `rpc:cancel` stops the command when the caller withdraws — the group at once, or the owner first
when its profile declares cooperative cancellation ([ADR 0013](0013-cooperative-cancellation-ends-at-the-callers-deadline.md)).
It was the one place the call plane was genuinely weaker, and the one place it leaked: a withdrawn
call used to run to its own timeout.

## Rejected alternatives

**Fold the command plane into service bindings.** Rejected above: it narrows the envelope, deletes
the exit code and truncation flag, drops both rate limits, and cannot express two live profiles at
all. The gain it promised — a declared response schema — does not exist: `ServiceOperationSchema` is
`{id, effect, limits}`, and the transport validates only "one JSON document under N bytes".

**Delete `/wire/call`.** It removes a capability rather than a duplicate. Services need a server
that is already running; a node that answers one question a minute should not have to keep one.

**Keep one coarse `rpc` grant and add a second narrowing table.** Two tables that must agree is the
failure mode this project already documents elsewhere: they diverge silently, and the divergence is
fail-closed but mute.

**A `command: '*'` wildcard.** It restores exactly the blanket permission this replaced. A table
that can say "anything" is a table nobody reads.

## Consequences

- Broker configuration grows: every caller/command pair is a line. That is the point — the table is
  now a list of operations rather than a list of nodes.
- Every node configuration changes: bare-path entries become declared profiles. This is a flag day,
  which this fleet already pays for on every release (ADR 0007).
- `failure` gained `cancelled`. A consumer matching exhaustively on that enum sees a new arm.
- Profile streams still use the addressed `stream` capability. Service streams instead use the
  same service-read/exact-operation grants as unary service calls; both producer kinds share the
  stream delivery state machine and differ only at source acquisition.

## Revisit when

Every target on the fleet keeps a persistent local server anyway. On-demand execution would then be
a transitional capability rather than a needed one, and the caller-facing surface could shrink to
one plane — at which point the arguments above become a migration checklist rather than objections.
