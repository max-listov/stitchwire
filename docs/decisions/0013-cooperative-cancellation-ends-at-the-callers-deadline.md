---
title: "ADR 0013: cooperative cancellation ends at the caller's deadline"
description: A command owner may finish its transaction after a withdrawal or deadline, but the caller's answer is settled by then and the owner's state is learned by reconciliation.
type: decision
status: accepted
created: 2026-10-05 19:39 +07:00
updated: 2026-10-05 19:39 +07:00
---

# ADR 0013: cooperative cancellation ends at the caller's deadline

## Context

A command profile may declare `cancellation: { mode: 'cooperative', graceMs }`. On withdrawal or
deadline the target then signals only the owner process, and the owner may take up to fifteen
minutes to finish or roll back a child transaction before the group is killed. Three parties see
that stop at different times:

- the **caller** settles `cancelled` the moment it withdraws (it stopped waiting by its own choice)
  and `timeout` when its deadline passes;
- the **broker** settles the call when the caller withdraws or when `timeoutMs` plus its grace
  passes, releases its inflight slot, and ignores any later `rpc:result`;
- the **target** holds execution admission until the owner and its pipes have settled.

So a terminal document that the owner prints during a long cooperative stop does not reach the
caller, and the broker's slot is free while the target's admission is still held.

## Decision

The caller's deadline is the caller's contract and it is not extended by the target's grace.
Withdrawal and timeout settle the caller as they do today. What the owner did during the grace is
learned from the owner — its own journal, a follow-up status command, or reconciliation — never from
the withdrawn call's answer. `cancelled` and `timeout` say that the caller stopped waiting; they do
not say whether a side effect happened or was rolled back.

Capacity follows the side that holds the work. The broker's slot measures calls in flight on the
wire; the target's admission measures processes on the machine. A call to a target still finishing
a cooperative stop is admitted by the broker and refused by the target as `capacity`, which is the
true answer. A profile that needs exactly one run declares `concurrency: 1`, and the target enforces
it.

A shutting-down agent does not inherit the owner's grace. It asks running commands to stop, waits a
fixed short budget well inside its own shutdown grace, then kills every group it still owns while it
is alive to do so. The grace timer lives in the agent; an agent that exited first would leave the
owner's detached group with no bound and a restarted agent could start a second copy beside it.

The owner is the one who decides what happens to the processes it started. When it exits, whatever
remains in the group has outlived it and is killed at once; an owner that leaves a helper mid-work
has abandoned that work. Output a stopping command prints is dropped, not delivered: the caller is
not listening, and the owner records its outcome where it can be read later.

Commands run through `stitchkit/process`: the profile's cooperative grace is the `stop` policy
(`target: 'leader'`, `graceMs`), the agent's shutdown is its `killOn`, and a Wire profile without
`cancellation` stops the whole group with SIGTERM and KILL after 500 ms.

## Rejected alternatives

**Deliver the owner's late result to the caller.** The broker would keep the call pending for up to
the target's grace, which the broker and the caller do not know, and the caller's deadline would
mean "deadline, unless the target chooses otherwise". A caller that withdrew is, by definition, not
listening.

**Let shutdown wait the full grace.** Service managers stop an agent on a clock of seconds, not
minutes, and the stop would arrive as a forced exit that loses exactly the bound this decision keeps.

## Consequences

- An owner that must report its outcome publishes it where it can be read later (a journal or a
  status command), and callers reconcile after `cancelled` or `timeout`.
- A cooperative transaction interrupted by an agent shutdown is killed after the shutdown budget;
  owners must be safe against SIGKILL at any point, as they already must be against a host crash.
