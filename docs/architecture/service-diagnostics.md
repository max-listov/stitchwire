
# Unary service call diagnostics

Door version 7 accepts an optional `traceId` and journal recovery status; the SDK requires runtime Door 7,
with no fallback to the old strict schema. Runtime peers require the same release.
Owner ingress JSON does not change: `id` remains the unique transport request ID.

## Correlation and phases

The SDK creates a UUID before validation/admission/dispatch or accepts a given caller UUID.
`traceId` is not authority and not a pending key: identical traceIds do not merge requests.
Every dispatch gets a new `requestId`; correlation also takes caller/target into account.

`invokeService(input, {onTrace})` reports `start` before waiting and `result` when the
outcome is received. `createServiceFetch(client, {...binding, onTrace})` reports start before reading the body
and result when a unary call ends: with the outcome received, or without diagnostics when the body is refused
or the client throws, so every start has its result. The observer is synchronous and must not throw. A stream
has a separate lifecycle.

The SDK passes `x-stitchwire-trace-id` to the Unix Door, then Wire passes it to the owner HTTP.
It is only a correlation header, not credentials. The door writes `door-entry` before body parsing
and admission, `door-parsed` after parsing, `door-result` after the call, `door-terminal`
on completion/cancellation. All door offsets count from raw entry. Before parsing,
target/service/operation are unknown, and the fields are absent. An invalid header or a header/body
traceId mismatch is refused; without either identifier the Door generates its own UUID.
A caller with an explicitly set body traceId passes the same header, as the SDK does.

The result contains the traceId; a received outcome may contain `diagnostics` with traceId,
requestId and at most 16 target phases: receipt, descriptor start/end, admission,
endpoint start/end, HTTP start/headers, body start/end, terminal.
`WireServiceError` provides diagnostics and cancellationOrigin;
`WireClientError.metadata` provides traceId, the available local timing and the observed local origin.
The fetch adapter hands out the correlation response header and target phases through onTrace,
without adding metadata to the domain response JSON.

Target offsets are monotonic, from executor entry. An unfinished start/end pair indicates
an unfinished phase; absence of a measurement is not zero. Clocks of different processes
are not subtracted. HTTP duration includes owner scheduling and I/O, but does not prove
an internal queue or a CPU cause in the owner.

## Cancellation and the bounds of knowledge

The SDK distinguishes caller abort/deadline at the moment it fires. A Unix headers timeout
is not called a caller deadline: the transport cause remains in error.cause.
The Unix Door observes door-disconnect, but not the JavaScript cause in another process.
Caller lane, broker and executor name their own deadlines; disconnect and
agent/broker shutdown have separate origins. Caller cancel accepts only
caller-side causes at the authenticated boundary. The first abort is kept; cleanup
does not override it.

An origin does not replace delivery certainty: after dispatch, cancellation does not prove that the
owner stopped or that a write did not happen. No retry is added. Executor shutdown
stops admission, cancels and waits for active unary calls, including loopback;
the terminal trace is written before the service audit closes.

After an external abort, late target phases cannot be delivered to a caller that is gone.
The consumer keeps local facts and the traceId; remote facts are available in the received outcome
or the operator journal. There is no diagnostic RPC, polling, retained request registry or
promise to recover lost history. If an outer wrapper loses the cause,
the consumer keeps onTrace itself.

## Bounded journal

The agent writes `${agentSocket}.service-audit.jsonl` separately from publication history:
8 MiB per file, two rolled generations, 256 pending records and a shared byte ceiling
of the diagnostic journal. `status.serviceAudit` shows drops/write failures.
Only fixed identifiers, phases, durations, outcome code and cancellationOrigin
are projected; payload, arbitrary headers and AbortSignal.reason are not written.
The broker service audit contains traceId, requestId and its own terminal observation.

### Journal recovery and reading

Stitchkit owns startup recovery and the bounded `readDiagnosticJournal`. Corrupted bytes
are kept; the reader returns valid frames and separate anomalies with file/offset/line,
reason and skippedBytes. I/O errors and unsafe paths throw instead of becoming
a successful empty read. Wire does not repair JSONL with its own parser or trim.

The optional `AuditStatus.recovery` is a bounded startup observation: filesChecked,
anomalies, skippedBytes, first/last anomaly and the files set aside (`quarantined`,
`quarantinedUnlisted`). A clean journal does not contain this field. Startup checks only the last
line of each file (`startupScan: 'tails'`): a corrupted line in the middle of a file is not searched
for on open, otherwise every restart would parse up to 64 MiB per generation.
Doctor shows recovery as a warning separately from dropped/writeFailures. It is not a current
counter of write failures and not a promise to recover damaged facts. The observation may
repeat after a restart while a retained corrupted generation stays on disk.

A corrupted active tail is isolated into a rolled generation, so the broker config requires
`auditRotate.keep` of at least 1: with `keep=0` there is nowhere to isolate the tail. The value is
rejected when the configuration loads, not during recovery.

A file the journal cannot leave in place (a single corrupted slot, not a regular file,
unreadable) does not stop the broker: it is renamed to `<file>.quarantined-<epoch>` next to the
journal (`onStartupRefusal: 'quarantine'`), not deleted, and listed in
`recovery.quarantined` until the operator removes it. Doctor shows this as a separate check
`audit.quarantined` (warn). A broker that lost all decisions to preserve one corrupted
file is worse than a broker that started and named the file it set aside.
The ordinary configured retention stays in effect on further rotation; recovery does not
promise indefinite retention of evidence.

### Service audit compaction

Broker audit schemas own the disk DTO; TypeScript types are inferred from these schemas.
The service audit schema reuses the canonical failure codes/delivery classes and adds
only the existing audit success states `admitted`/`received` and delivery `delivered`.
These are transport observations, not business results of the owner operation. AuditStatus uses
the shared door schema, not a separate hand-written DTO writer.

Broker success facts use `service-batch`: shared `from`, `to`, `service`, `operation`,
a `calls` dictionary with `id`, optional `traceId` and `requestBytes`, and up to 64 `rows`.
Each row contains the `call` index, the exact `ts`, the writer-owned `ordinal`, phase, outcome,
duration, responseBytes, delivery and transportCause. `serviceAuditRecords` expands
the current contract without guessing the operation effect. `ordinal` orders service facts
within a journal epoch independently of physical grouping; the epoch comes from the envelope.
It is required on a written individual `service` and on every batch row.

Unsuccessful transport outcomes and cancellation remain individual `service` records;
a single fact and a batch that does not fit the file/event ceiling are also written
individually. These are two forms of the current contract, not a reading of an old format.
The broker has no owner descriptor with the operation's effect: a grant or a `*.read` name
is not used as proof of the absence of a side effect. Successful writes
are not lost and are not collapsed into one counter: each keeps an individual fact.

Buffer: at most 128 route groups, 1024 logical rows and 1 MiB of conservatively counted
input data. Flush on a full batch/buffer, 1000 ms after the first row and on explicit
flush/close. Records of other kinds do not flush the batch: on a live broker, event publications
arrive between almost every two service facts. So a batch may land in the journal later than
neighbouring records; the order of service facts is given by `ordinal` and `ts`, not by the position
in the file. The timer depends on the event loop:
a stall may delay the flush; fsync and crash durability are not promised. An abnormal exit
may lose the unwritten interval. `queued` includes pending journal frames and
buffered service rows; `dropped` counts all logical rows of a refused batch.

The broker collects callback delays of 250 ms and more into ten-second monotonic windows:
count, max delayMs, windowMs, first/last observation timestamps.
A quiet tick flushes the closed window; managed shutdown flushes the last non-empty aggregate.
Memory is O(1), empty windows are not written; health keeps a separate five-minute window.
Count means measured late callbacks, not an established cause of a host incident.
On abnormal termination the last aggregate may be lost; drops matter for
any conclusion drawn from the absence of a record.
