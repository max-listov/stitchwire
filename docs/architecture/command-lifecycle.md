---
title: Declared command lifecycle
description: How a command profile bounds a call's deadline, cancellation and cleanup on the target.
type: architecture
status: active
created: 2026-10-03 08:57 +07:00
updated: 2026-10-17 16:14 +07:00
---

# Declared command lifecycle

A broker grant names one command profile; the target maps that name to an absolute executable
and fixed argv. A profile with `callerArgs: { mode: 'none' }` and `stdin: { mode: 'none' }`
accepts neither caller arguments nor an input document. Different fixed operations use different
profile names, even when they invoke the same executable.

The caller explicitly supplies a deadline for long operations. Command requests and profiles
allow at most one hour (`MAX_COMMAND_TIMEOUT_MS`); profile admission enforces its own smaller limit.
The ordinary default is 30 seconds and streams keep their own 15-minute ceiling.
Unary response headers arrive only after execution; the SDK's operation deadline covers both
headers and body, so a quiet command is not cut short by the stream-opening timeout.

## Cancellation authority

Ordinary commands (`runNativeCommand`) and profile streams (`streamNativeCommand`) run under one
Stitchkit owner and signal the process group with SIGTERM, then SIGKILL after 500 ms. This also
cleans up descendants whose leader has already exited.

A command owner that coordinates a child transaction may declare:

```json
{
  "bin": "/opt/example/transaction",
  "argv": ["apply", "--json"],
  "callerArgs": { "mode": "none" },
  "stdin": { "mode": "none" },
  "timeoutMs": 3600000,
  "cancellation": { "mode": "cooperative", "graceMs": 900000 },
  "concurrency": 1
}
```

On deadline or authenticated withdrawal, Wire signals only the owner process with SIGTERM.
The owner decides how to cancel preparation or complete its transaction and recovery, and what
happens to the processes it started: when the owner exits, anything still in the group has
outlived it and is killed at once. If the owner exceeds the configured grace, Wire kills the
entire group. What a stopping command prints is dropped. The grace is bounded at
15 minutes (`MAX_COMMAND_CANCELLATION_GRACE_MS`) and repeated cancellation cannot extend it.
Execution admission stays held until cleanup completes. An already withdrawn invocation never
starts an executable.

Cooperative mode is an explicit assertion by the executable owner that it handles SIGTERM;
it is not a safe default for arbitrary binaries.

## What the caller learns

The caller's deadline is not extended by the target's grace ([ADR 0013](../decisions/0013-cooperative-cancellation-ends-at-the-callers-deadline.md)).
A withdrawing caller settles `cancelled` at once; a caller whose deadline passes settles `timeout`.
Neither outcome says whether a side effect happened or was rolled back, and a terminal document the
owner prints during its grace is not delivered to that caller. The owner's own record or a later
reconciliation is authoritative for domain state. Neither mode retries an invocation.

While an owner finishes, the broker has already released the call's slot and the target still holds
its admission; a new call to that profile is refused by the target as `capacity`.

## A lost connection

The broker settles a call by the socket it was dispatched to, not by the node's name. When that
socket is lost the caller hears `transport` / `lane-lost-after-dispatch` at once, not at the
deadline, and the delivery is `unknown`: the command may have run. Calls dispatched to the node's
new connection are not touched.

A command still running on the lost connection is stopped on the target the way a withdrawn one is
(cooperatively, as above): the caller was told the call was lost, the broker refuses an answer to
it, and an effect that landed after that report would belong to nobody. A cooperative owner decides
how to finish its transaction within the grace; its result is not sent. The node's reconnected lane
starts clean: calls dispatched to the new connection are not stopped.

A caller that disconnects is a withdrawal: the broker tells the target to cancel (cooperatively, as
above) and journals the call as `cancelled`.

## Agent shutdown

A stopping agent asks every running command to stop, waits at most `SHUTDOWN_COMMAND_GRACE_MS`
(5 seconds, inside the agent's own shutdown grace), then kills every group it still owns. A
cooperative grace never outlives the agent that enforces it, so owners must tolerate SIGKILL at
any point, as they already must tolerate a host crash.
