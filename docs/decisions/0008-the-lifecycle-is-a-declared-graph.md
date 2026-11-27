---
title: "ADR 0008: the lifecycle is a declared graph"
description: Both processes become managed applications; the shutdown order follows declared edges instead of statement order, and a failing resource reaches the operator with what it threw.
type: decision
status: accepted
created: 2026-08-25
updated: 2026-08-25
---

# ADR 0008: the lifecycle is a declared graph

## Context

The broker and the agent each hand-rolled their own lifecycle. Startup was a sequence of `const`
bindings; shutdown was a list of statements that was correct because whoever wrote it put them in the
right order, and nothing anywhere said so. A failing subsystem reached the operator as a line in a
log, if at all, and `stop()` returned `void` — a promise that everything stopped, which is not a
promise a shutdown with a deadline can keep.

The framework this project is the default consumer of spent four releases building exactly this:
resources with `dependsOn`, phases (`stopAdmission` → `drain` → `close` → `force`), a shared budget
vocabulary, an observer that carries the thrown value, and a shutdown that reports what it achieved.
Not using it while claiming to be the reference consumer was the gap.

## Decision

**Both processes are managed applications.**

Broker — two resources, one edge:

| Resource | Depends on | What its phases do |
|---|---|---|
| `audit` | — | starts the append-only writer; `drain` flushes it |
| `wire` | `audit` | builds the socket, router and HTTP server; `stopAdmission` drops pending calls and terminates streams and subscriptions with explicit reasons |
| `wire-server` | `wire` | `managedServerResource` — the server's own shutdown machine, adopted rather than copied (0.16.0) |

The edge is the one ordering that matters: a broker that can admit a call before it can record one
has a log with a hole at exactly the moment something went wrong. Reversed on the way out, it keeps
the record of a shutdown inside the shutdown.

Agent — two resources, one edge, and the edge is not the obvious one:

| Resource | Depends on | What its phases do |
|---|---|---|
| `lanes` | — | constructs the broker connections; reports their health once startup is over; `close` tears them down |
| `door` | `lanes` | builds the Unix-socket server; `stopAdmission` ends every long-lived local answer |
| `door-server` | `door` | `managedServerResource` — the server's own shutdown machine (0.16.0) |

## The two decisions inside that table

**A lane is ready when its dialer runs, not when a broker answers.** Reading readiness the other way
would make the door wait for a broker, and a node whose every lane is down still answers its
neighbour with `connected: false` — the difference between a machine that reports its situation and
one that hangs. Reconnection is a lane's normal life, not a startup condition.

**Long-lived answers end before anything waits on them.** The door's NDJSON responses finish only
when their source iterator does, and that source lives in the lanes. Closing the lanes first ends
them — but then a local caller arriving in between is told the transport failed when the truth is
the agent is going away. Closing the door first without ending them deadlocks: the server waits for
a stream whose source is still alive. So `Agent` gained `drainLocal()`, separate from `stop()`.
**This ordering bug existed before and was invisible**; declaring the graph is what exposed it.

*Amended in 0.16.0:* that call moved from `drain` to `stopAdmission`, and the reason is worth
recording because it is a property of the kernel rather than of this code. Every phase is walked in
REVERSE dependency order, awaiting one resource at a time. The server adapter therefore runs ahead
of the resource it depends on in every phase: its `stopAdmission` starts the server's shutdown
without waiting, and its `drain` awaits it. That wait cannot finish while the door is still
answering — so ending the answers on `drain` puts the two in a deadlock resolved by the grace
deadline instead of by either of them. Measured, before the move: a test's teardown hung until its
budget expired. One phase earlier, the answers are already over when the server begins to wait.

## A teardown must survive a start that produced nothing

Invoking a resource's `start` makes it rollback-eligible immediately, so its `close` runs even when
that `start` rejected before producing anything. stitchkit states this in
`docs/guide/application-kernel.md` and on the type itself; this project broke it on the first day and
paid for it twice.

`door.close` called `server.shutdown()` on a binding the failed `start` never assigned. The crash
joined the rollback, and an honest `unix socket … is already in use by a live listener` became
`AggregateError: application startup and rollback failed` — **a diagnosis destroyed by the cleanup of
the thing being diagnosed.** Reading that as "the framework hides the cause" produced a second
mistake: an observer that kept the first failure and rethrew it, which replaced an aggregate naming
both the start failure and the rollback failures with a flat error naming only one. Strictly less
information, dressed as more.

Neither was needed. A required resource's failure is rethrown untouched when rollback is clean, and
carried as `cause` when it is not. Every teardown callback here now checks its binding, and the
original error reaches the caller unwrapped — pinned by a test that asserts the error is not an
aggregate, because that is the observable difference.

`onResourceFailure` stays, as a log line that names the resource and the phase for every phase,
including `drain` and `close` where nothing is thrown to a caller at all.

## Consequences

- `stop()` returns `ApplicationShutdownResult` instead of `void`, and takes the shared budget options.
- Since 0.16.0 the budget is also declared once on the application itself. stitchkit 0.61 made a
  failed `start()` roll back on that same budget, and on the framework defaults a startup refused by
  an occupied socket would take 35 seconds to say so — during a rollout that reads as a hang. Ten
  seconds of grace is generous for what has to finish, because every long-lived answer is already
  over one phase earlier.
- `startAgent()` is async, because a lifecycle that starts resources in order cannot be synchronous.
- A resource failure names itself; previously an operator saw a phase label or nothing.

## What was deferred, and what became of it

**The status projection was deferred in 0.13.0 and taken in 0.15.0** — additively, beside the domain
rather than instead of it, so no consumer changed and the door stayed at `2`.

One line of that deferral was simply **wrong** and is corrected here rather than left standing: it
said this project "conflates `ready` versus `health` into one `ok`". It does not. `ok` is
`writeFailures === 0 && dropped === 0` — a pure audit fact, about the journal and nothing else. The
whole question of what replacing it would cost consumers came from misreading our own code.

**Two adoptions were blocked by the framework and are now taken.** `managedServerResource` fed a
whole-millisecond schema a fractional clock and failed every phase it ran in; `reportHealth` inside
`start` was silently discarded. Both were reproduced in isolation, filed upstream, and fixed in
stitchkit 0.61 — and until then this repository kept the status quo rather than building a
workaround around either.

**`completion` is deliberately still not declared, and this is the settled answer rather than a
deferral.** It guards a resource whose death would otherwise be invisible: a poller that stops
polling while the process keeps answering. Neither half of this transport has one. The case the
0.13.0 task imagined — "the broker's HTTP server dies and `/health` keeps saying `ok`" — cannot
happen, because `/health` is answered by that same server: a dead server answers nothing, so it
cannot answer falsely. A promise polled by a timer to satisfy the checklist would be machinery
defending nothing.
