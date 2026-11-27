---
title: "ADR 0009: a state with no deadline is indistinguishable from healthy waiting"
description: Six defects of one class in a single day across two projects. Every wait in this transport now either has a deadline, publishes a sign, or records why it legitimately has neither.
type: decision
status: accepted
created: 2026-08-26
updated: 2026-08-26
---

# ADR 0009: a state with no deadline is indistinguishable from healthy waiting

## Context

Three defects in this transport in one day, each wearing a different face and none caught by a test:

| where | how it looked | what it was |
|---|---|---|
| a quiet subscription at the door | "subscribed and quiet" | a connection the runtime severed every ten seconds |
| `ok: true` with no attempt behind it (0.17.0) | "the last check succeeded" | there had been no check |
| the merge with a local source (0.19.0) | "waiting for an event" | a refusal collected and never handed over |

The consumer on the other side of the door hit the same class twice the same day — a lane with no
silence deadline, a run with no terminal — and named it in one sentence, which is the title of this
record.

**Why tests did not catch any of the six.** Every one is about the ABSENCE of a signal, and a test
written by default asserts a presence: publish an event, see it arrive. Nothing arrives in these
failures either, and that is the bug. The scenario "it never came" has to be written on purpose.

## Decision

**Every wait in this transport is one of three things, and which one is written down:**

1. **Bounded by its own deadline.** A lane acknowledgement, a publish acknowledgement, a stream's
   `timeoutMs`.
2. **Bounded elsewhere, by contract.** The consumer iterators wait indefinitely because silence is a
   topic's normal state — and the bound that does exist is the broker's `subscriberIdleMs`, which
   can tell a slow subscriber from a quiet topic where this side cannot. Two deadlines for one
   failure would give it two verdicts depending on which fired first.
3. **Deliberately unbounded, with the reason recorded at the wait itself.**

The distinction between (2) and "unbounded because nobody thought about it" is invisible in code.
It exists only if it is written, so it is written — at each site, not in a summary somewhere else.

**A queue with no bound is the same defect wearing its other face.** Unbounded waiting and unbounded
growth are both a state that looks like work. `LocalEventLane` shipped in 0.19.0 without a bound; it
now discards past its buffer, counts what it dropped, and announces the first one.

**Overflow on the local lane discards rather than blocks**, and only because that lane is an
accelerator rather than a source of guarantee: the same event is already travelling through the
brokers, whose path carries the credit accounting and the explicit gap. Blocking would push back on
a publisher for the benefit of one slow local reader — a latency optimisation turned into a
fleet-wide stall. No other queue in this transport may make that trade.

## A test for this class asserts both sides

A test that only proves the guard fires **passes just as happily on a mechanism that is broken
outright** and delivers nothing at all. The neighbouring project nearly shipped a fix that way and
caught it only by removing the guard and checking that the test then failed.

So `test/bounded-waiting.test.ts` asserts the reader that keeps up receives everything, alongside
the reader that falls behind being bounded — and this was verified the way the neighbour described:
with delivery disabled outright, four of its five tests fail.

## Consequences

- `local-events.ts` carries `maxBuffered`, a drop counter and a first-drop line.
- `multi-home-events.ts`, `event-consumer.ts` and `stream-consumer.ts` state at each waiting site
  which of the three kinds it is.
- The open question of a mechanical rule — lint every `new Promise` without a timer beside it — is
  answered **no**. Half the sites are legitimate, so the rule would be suppressed everywhere within a
  week, and a suppressed rule is worse than none: it looks like coverage.
