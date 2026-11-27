---
title: Bounded runtime diagnostics
description: One-shot wire checks and opt-in process memory diagnostics.
type: architecture
status: active
created: 2026-08-31
updated: 2026-11-02 18:05 +07:00
---

# Doctor

`stitchwire doctor` inspects the local agent through its Unix door. `--config <path>` selects
the node configuration and its socket; the loaded configuration identity must match.
If a local broker configuration exists at the default configuration location, its active
audit journal is also inspected, even when the agent door cannot answer.

`stitchwire doctor --broker <base-url>` instead reads that broker's existing `/health` endpoint.
It does not start a node, connect a second data-plane client, or inspect every machine's filesystem.
HTTPS is required except for loopback HTTP. URLs containing credentials, query strings or fragments
and all redirects are rejected. `--broker` and `--config` cannot be combined.

Both modes support `--json`. Text and JSON are renderers of the same versioned report:
`v:1`, `scope`, `capturedAt`, `verdict`, `exitCode`, and `checks[{code,level,detail}]`.
This is the doctor report version, not the local door or runtime protocol version.
Raw status remains available through `stitchwire status --json` and the SDK status method.

| Exit | Verdict | Meaning |
| --- | --- | --- |
| 0 | ok | All checks in the selected scope completed without findings |
| 1 | warn | Completed measurement has a warning |
| 2 | fail | At least one confirmed diagnostic failure |
| 3 | unknown | No confirmed failure, but one or more required observations are unavailable |

A confirmed failure takes precedence over unknown; unknown takes precedence over warning.
Individual findings remain visible regardless of the aggregate. Invalid configuration, missing
socket, timeout, invalid JSON/schema and oversized response cannot result in a green report.
Each network observation is bounded by five seconds and eight MiB, with no retry or redirect.
The command creates no checkpoint, timer or background process and performs no automatic repair.

## Coverage

Node checks include every lane, declared command/stream endpoint and cwd, configuration identity
and permissions, lifecycle readiness, publication audit, release identity and subscription slots.
A lane that is down reports its last transport failure — the message, when it happened, and whether
it was terminal — because `down` alone names a symptom the agent already knows the cause of. A
terminal failure is one no amount of waiting repairs, such as a release mismatch; a dropped
connection is retried indefinitely and is not terminal. A connected lane reports no failure even
when one is still remembered.
Missing optional observations are unknown, not zeros. At or above 75% subscription occupancy,
remaining free slots produce a headroom warning; an exhausted or invalid budget fails.
The warning reports capacity risk, not an observed refusal or a leaked reader. Historical local
subscription refusals are not part of the status contract and are not inferred from occupancy;
an actual refused subscription still returns its typed capacity failure to the caller.
The subscription check prints logical used/limit/free, the numeric headroom threshold and whether
capacity is exhausted. Topic rows count logical readers; lane rows count local lane handles and
state explicitly whether the broker is connected. Status includes timestamped complete logical
reader enumeration, bounded by node admission, without payloads or inferred process identities.

Broker checks include lifecycle readiness, audit loss/rotation ceiling, observed fleet versions,
per-topic occupancy, publication policy and rejection age. A periodic topic's silence uses the
existing bounded cadence evaluator. An on-change topic has no inferred heartbeat obligation;
unknown policy stays unknown. Rejections within15minutes are warnings; lifetime counters are
displayed without pretending they occurred during this probe. Subscription admission count and
its actual recent window are reported together, not converted into an assumed full-hour count.

## Operator boundary

Deployment inventory, required node uptime, churn thresholds, scheduling, alert routing and
freshness of observer receipts belong to the operator. Offline roaming nodes are not universally
faults. Compare multiple brokers and inspect required nodes explicitly; one broker's roster is
not independent proof of all nodes' local health. The report timestamp describes this probe, not
continuous coverage or business-data freshness. Public output can contain diagnostic node/topic
identifiers and is intended for the authorized operator, not an unauthenticated public endpoint.

A long-lived observer consumes the installed artifact or supported API, not a repository-relative
script. It must independently detect missing successful runs. A generic Wire diagnostic fix does
not install that observer or authorize changing consumer deployment configurations.

## Process memory attachment

`scripts/memory/preload.ts` is an opt-in Bun preload for one bounded diagnosis of an installed runtime
entry. It is not a long-lived observer: it ships in no package, so build it from the exact source
outside the checkout and attach the result for the length of the diagnosis:

```sh
bun build scripts/memory/preload.ts --target bun --outfile <dir>/preload.mjs
bun --preload <dir>/preload.mjs <runtime-entry> agent
```

It opens no network listener. Every five minutes it records live heap statistics after two forced
collections, process memory, cumulative CPU and the collection time under the configured state
directory's `memory/` subdirectory. A probe that cannot start, sample or capture logs it and never ends the process. `SIGUSR2` requests a complete JavaScriptCore Inspector v3 graph and a class summary.
Signal only the PID verified against the supervisor and process start; a bare process name is not
an identity. Each attachment gets a separate directory with its PID, start time and Bun build.

Directories are `0700`, files `0600`. Graphs and property names can contain private data and stay
local. Summaries contain class counts and shallow bytes, not payload values. A snapshot's SHA256
binds it to its summary. A snapshot temporarily allocates memory and pauses JavaScript; capture
duration is recorded, and the pause grows with the heap: about 0.9 s at 142 000 cells, 15 s at 1.5 million. Neither prior samples nor graph objects are retained by the probe.

```sh
bun run memory:compare <earlier.summary.json> <later.summary.json> --type Promise
```

The comparison verifies hashes, rejects different epochs/builds and requires at least 24 hours by
default. `--minimum-hours 0` explicitly permits an exploratory short comparison; it is not long-term
acceptance. Retaining paths expose class and edge kinds only. Growth alone does not identify a leak.

Forced GC changes the workload. Keep natural footprint and post-GC series separate, record active
traffic and gaps, and distinguish object retention from heap capacity, JIT and allocator memory.
A forced collection stops JavaScript for its whole duration; read `collectionMs` before trusting a
latency measured under the probe. Remove the preload and restart the supervised agent to detach: the
preload survives every restart until then, and it keeps collecting when nobody reads the result. Observation cadence, deadlines,
completion wakeups, supervisor configuration backup and restoration belong to the operator.
