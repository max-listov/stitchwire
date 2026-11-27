---
title: "ADR 0012: a test timeout bounds a hang, never a duration"
description: The suite's per-test budget is 30s because bun's 5s default is an accidental performance assertion over 43 files that spawn processes, and a set that reddens from luck is worse than one that is merely slow.
type: decision
status: accepted
created: 2026-09-02
updated: 2026-09-02
---

# ADR 0012: a test timeout bounds a hang, never a duration

## Context

Three consecutive full runs of this suite, on one unchanged tree, failed three DIFFERENT tests.
Each passed on its own, three times out of three:

| Run | Failing test | Elapsed |
| --- | --- | --- |
| 1 | `doctor text and JSON use the same verdict …` | 15007ms against an explicit 15000ms |
| 2 | `producer boot change emits provenance gap …` | 159ms |
| 3 | `killing the writer mid-rotation leaves no torn line …` | 5047ms against the 5000ms default |

The measured cause is not three bugs. bun applies a 5000ms per-test default, and 43 files in this
suite spawn processes, bind sockets and write real files — then bun runs those files concurrently.
A budget set close to the honest cost of the work is not a bound on hanging; it is an assertion
about speed, made accidentally, and a loaded machine collects it.

That is the expensive failure, and it is expensive in a direction that is easy to miss. A false RED
costs what a false green costs: a set that reddens from luck teaches everyone to disbelieve a
failure, and the next real one is waved through by a habit this suite itself taught. Repeating the
run until it is green is not a repair either — a repeat looks for confirmation, and it finds it.

## Decision

The suite runs with `--timeout 30000`, in the `test` script rather than in `bunfig.toml`: the
`[test] timeout` key was tried and MEASURED not to take effect — a 6s probe still failed at 5.02s —
so a config file would have been a change that did nothing while looking like a fix.

A per-test timeout answers "did this finish", never "was it quick". Raising it weakens no
assertion: a genuine hang still fails, later. Slowness is a question for a benchmark, which can say
what got slower and by how much; a timeout can only say that one machine, on one run, was busy.

Two tests keep larger explicit budgets because their own cost is genuinely high — `doctor.test.ts`
spawns sixteen CLI processes in one case. Its idle cost is **6.92s**, measured four times with no
variation (6.97/6.92/6.92/6.92), while the same work exceeded 15000ms under a full parallel run.
Load more than doubles it, and a ceiling with 2.2x of headroom was still eaten.

The first version of this record said "about 12s" from a SINGLE reading taken while another gate was
running in the background — a number measured once, under uncontrolled conditions, written where the
next reader would reason from it. Corrected after a neighbouring project nearly moved a coverage floor on
one outlier and stopped to measure the same tree five times instead. The conclusion here survives and
is stronger, since the margin was larger than claimed and load ate it regardless; the figure was
simply wrong. Its budget is a bound on hanging, not a number nudged upward each time it trips; the
file's own comments record that it was already on that treadmill at five seconds.

## Consequences

- A test that hangs still fails, and takes up to 30s to say so.
- A performance regression will NOT be caught here, and never could have been: the 5s default only
  caught it on a machine that happened to be idle, which is the same as not catching it.
- Waiting inside a test is on a CONDITION with the clock as a ceiling, never on a duration. Where
  that rule was broken — three `sleep(20)` calls in the event-router tests — the fix was the
  instrument, not the number, and the wait was then proved load-bearing by removing it.
