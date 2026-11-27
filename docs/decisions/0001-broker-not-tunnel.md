---
title: "ADR 0001: a broker with outbound connections, not a tunnel, VPN or key"
description: Why the "server → laptop" direction is solved by a broker that every node dials itself; what was rejected and how this decision differs from Teleport, AWS SSM, Salt, Choria, konnectivity and osquery, which share the same topology.
type: decision
status: active
created: 2026-08-18
updated: 2026-10-17 14:43 +07:00
---

# ADR 0001: a broker, not a tunnel

## Context

The fleet map was directional: the laptop (the trust hub) reached the servers, the servers did not
reach it: no address, no port, no sshd. A live incident on 2026-08-05: an agent on a server finished
delegated work and had no route to hand back the result.

## Decision

A separate `stitchwire` service: a broker on a generic broker host behind nginx, and each node holds
one outbound Socket.IO connection. The direction of the TCP connection and the direction of a call
are unrelated. No node listens on a port; no node holds a credential to another node; the broker
stores only token digests and the ACL (default-deny). The receiving node executes only its own
`name → absolute binary` allowlist; there is no shell on the path, argv is an array, the body is stdin.

## Rejected alternatives

**A server key to the laptop (adding the laptop node to the ssh map).** Inverts the trust model: the
server gets a permanent shell on the hub. Moreover, the laptop has no stable address, so it solves
only half of the problem even at the cost of breaking the model.

**A reverse ssh tunnel (`ssh -R` + autossh).** The laptop becomes responsible for connectivity,
which it loses every time the lid closes or the network changes; the laptop node still needs sshd;
traffic flows only while a particular connection is alive. A permanent crutch with a manual lifecycle.

**Tailscale.** Solves addressing, but gives neither typing, nor per-command authorization, nor audit,
and still requires enabling sshd on the laptop. It provides connectivity in exchange for a third-party
daemon on the trust hub; a check showed that its daemon on the laptop node was not running anyway.

**An external broker (SaaS).** The content traffic of agent sessions (paths, code, client names)
would flow through someone else's infrastructure. A public edge, nginx and certbot already exist on
the broker host; an external provider would buy availability only in the "both servers are down"
scenario, in which there is nothing to transfer.

**A pull model (the hub collects mail from the servers itself).** Keeps the return channel tied to
the hub showing up eventually, and creates a second, unsynchronised source of truth. Rejected in the
design note of 2026-08-05 by its own arguments.

## Existing systems with the same topology

The first edition of this ADR compared the decision only with an ssh tunnel, Tailscale, an external
SaaS and a pull model, that is, with the weakest representatives of the field. A check on 2026-09-01
against each system's documentation showed that "the node dials out, an intermediary routes calls"
is a solution more than fifteen years old and implemented many times over.

| system | who dials | where it is decided what to execute | what the intermediary stores |
|---|---|---|---|
| Teleport | the agent dials the Proxy Service; no inbound ports on the node | cluster RBAC, on the Teleport side | audit and session recording |
| AWS SSM | the agent uses only outbound HTTPS to regional endpoints | IAM at the caller: who sends which Document | command history and output |
| SaltStack | the minion connects to the master (4505/4506) | `publisher_acl` on the master, for its users | job cache, event bus |
| Choria / MCollective | the choria server connects to the middleware | Action Policy per agent/action, on the node side | the middleware stores nothing |
| konnectivity | proxy-agent dials proxy-server | nothing: a TCP-level proxy with no notion of a command | nothing long-lived |
| osquery + Fleet | the node enrolls and polls the server itself | the server distributes SQL queries, not commands | configuration and results |

**The topology is not a contribution of this decision, and it must not be claimed as one.** The
contribution lies in where the authorization boundary runs and how much the intermediary weighs.

### How the authorization boundary differs

Salt and SSM authorize the **caller** rather than protecting the executor. `publisher_acl` limits
which modules are available to which master users, but the minion executes whatever arrives,
including `cmd.run`. IAM limits who sends which Document, but `AWS-RunShellScript` lives on the node.
In both systems, compromising the centre means a shell on every node.

Here a node will not execute what is not in its own `allow`. The broker cannot issue a command the
node did not declare, and therefore gains no power over it; this is the same property as storing
only digests instead of tokens.

Choria is the closest honest analogue: its Action Policy is also evaluated on the node side. The
difference comes down to weight and to the fact that a profile here also pins the executable, base
argv, cwd, env inheritance and budgets.

### What on this list is not replaced

Teleport, with its audit, session recording and short-lived certificates, solves the same transport
problem **for a human at a terminal**, which is not the goal. SSM is inseparable from AWS. Salt
carries a state layer, which is not here and is not planned. konnectivity does not know what a
command is. osquery is telemetry through an SQL engine.

### What remains a contribution after the comparison

1. **Size.** About five thousand lines of `src` versus hundreds of thousands in configuration
   management systems and Teleport's cluster with a database.
2. **A stateless intermediary.** The broker does not store payload, does not replicate and does
   not elect a leader.
3. **A refusal that cannot be confused with a result.** `offline`, `denied`, `timeout`, `transport`
   and `exec` are separated from the command's exit code. For a calling *agent*, unlike a human who
   sees the difference with their own eyes, this is the main property.

The third point is phrased as a property of this protocol, not as something the others lack:
there is no way to exhaustively verify "nothing like this exists anywhere else".

### Separately: the field of agent transports

The frame "a transport for agents, not for operators" is **not empty** as of 2026-09-01: A2A, ACP,
ANP, AgentRPC, overlay protocols for agents behind NAT and cloud agent gateways actively occupy it.
They call agent functions and tools; here a named local process is started on a remote machine and
its exit code and both streams are returned. This is a neighbouring field, not the same one, and
claiming the frame is empty is a mistake.

## Consequences

- Server↔server communication no longer depends on the owner's presence (previously transit lived
  only on forwarded-agent).
- A new machine joins with one config and outbound access, with no port, DNS or key exchange.
- The original single point of failure is closed by independent simultaneous broker lanes in
  ADR 0005; the base decision "broker, not tunnel" does not change.
- There is no queue: a call to a disconnected node honestly fails at once. Durable delivery is a
  separate task with its own semantics (at-least-once, idempotency key, TTL), not a side effect of
  the transport.
