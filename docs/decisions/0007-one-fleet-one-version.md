---
title: "ADR 0007: one fleet, one version"
description: Remove the protocol number and every form of backward compatibility; the handshake matches on the release, and a mismatch is refused where it can be seen.
type: decision
status: accepted
created: 2026-08-25
updated: 2026-08-25
---

# ADR 0007: one fleet, one version

## Context

The project carried three numbers — a wire protocol, a door contract, a release — and code paths that
still understood configuration shapes retired several releases earlier. All of that answered one
question: *which versions can talk to each other.*

This transport has no such question. Two brokers and four nodes belong to one owner and move in one
command; the 0.11.0 rollout measured the cost of a heterogeneous moment at **twelve seconds** for the
whole fleet.

Compatibility was not free twice over. It cost code and tests, and it cost a judgement on every
release — *is this breaking or additive?* That is the class of reasoning that shipped 0.10.0, where
"additive" was read as "roll out machine by machine" and half the artifact could not start.

Measured on the live configuration of all four machines before deciding:

| Shape | Live use |
|---|---|
| `acl` in broker config | none — both brokers use `capabilities` only |
| `url`/`token` pair in node config | none — all four use `brokers[]` |
| `allow: {name: "/bin/x"}` string | **all four** — the canonical form, misnamed as legacy |

## Decision

**There is no protocol version.** Homogeneity is checked once, in the handshake, against the release
version. A number saying "which dialect" and a number saying "which build" were two sources of truth
for one fact.

**No envelope carries a version field.** A socket that is admitted is the same build by
construction, so a per-frame version was ceremony. Frames are smaller and schemas say only what they
mean.

**A mismatch is refused at the gate, and named.** The audit records `node runs X, this broker runs Y`,
distinct from a bad token: a rollout that stopped halfway must read as a rollout that stopped halfway,
not as an authentication problem on a machine whose token is fine.

**Retired configuration shapes are refused, not normalised.** A broker config with `acl` and a node
config with `url`/`token` fail at load, on the machine, rather than starting something subtly
different from what is written.

**Wire fields are required.** The `.default()` tolerances existed for peers on older releases. There
are none, so a missing field is our own bug, and inventing a value for it would hide a denial as a
plain failure. Removing them immediately exposed two places relying on the tolerance.

## What is kept, and why it is not the same thing

- **The door contract keeps its own version.** A neighbour on the Unix socket holds no token, opens
  no lane, and has its own release cycle. It earned its keep the day the wire changed shape and both
  local consumers needed no edit at all. That cutover moved the door for its own reason: status no
  longer reported a wire protocol. Later door-shape changes advance the same independent boundary.
- **Rollback to the previous release.** A recovery path, not an interop mode, and it costs no code —
  only a preserved binary. It is fleet-wide by definition.
- **The `name → "/absolute/binary"` shorthand.** `docs/VISION.md` calls it the canonical form and
  every live node uses it. It was named `Legacy*` for historical reasons and read as debt because of
  the name. The name was the defect.

## What this costs, stated plainly

Every release is now a flag day, including one that fixes a typo in the CLI, and a single machine
cannot be upgraded to try something out. The window is twelve seconds for six processes, and trying
two versions against each other is what the release harness does locally with two binaries — never
something the fleet was used for.

## Consequences

- `scripts/release-smoke.ts` (was `mixed-version-smoke.ts`) asks one permanent question instead of
  re-deciding it per release: does the artifact work, does it refuse a fleet that is not itself, and
  does the release it replaces still run.
- Consumers reading `protocol` from `GET /wire/status` must stop; the field is gone rather than
  frozen at a value that would become a lie.
