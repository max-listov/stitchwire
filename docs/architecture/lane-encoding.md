---
title: Binary packets and lane compression
description: MessagePack and bounded zstd for packets between agents and brokers, with per-leg volume accounting.
type: architecture
status: active
created: 2026-09-26 15:59 +07:00
updated: 2026-10-17 14:43 +07:00
---

A data packet uses the standard Socket.IO header and one binary attachment.
The header keeps the event name and ACK id for regular Stitchkit tracing; MessagePack keeps the
service's JSON document as a string without re-escaping. For `event:publish`, `event:event`
and `stream:chunk` the `data` field travels as MessagePack binary; the base64 representation is
restored for the existing internal contracts and the Unix door. The transport neither parses nor
rewrites owner content. The client package works through the Unix door and contains no codec.

The codec is attached through the broker's regular `serverOptions.parser` and through the client's
peer loader. `socket.io-parser` parses the Socket.IO envelope and assembles the single attachment.
CONNECT/DISCONNECT/CONNECT_ERROR remain standard Socket.IO control packets.
The loader sets the Socket.IO parser; connection, reconnection, acknowledgements and contract
validation are still performed by Stitchkit. WebSocket and polling carry identical packets.

## Format and bounds

The binary attachment header is eight bytes: `SW`, version `1`, mode `0` (identity) or `1` (zstd),
then the unsigned big-endian length of the uncompressed MessagePack. Packets of 1024 bytes or more
are compressed with zstd level 1, only if the result is smaller than the original. There is no
dictionary shared between packets, no buffer accumulating several events and no decoding dependency
on previous frames.

The Socket.IO header is limited to 4096 bytes and one attachment. The attachment repeats the packet
identity; a mismatch of type, namespace, event name or ACK id is refused.
Before decompression the signature, mode, physical frame length and declared length are checked.
`maxFrameBytes` bounds the whole uncompressed MessagePack. Engine.IO additionally admits
only the eight header bytes. The decompressor is bounded by output size and by the maximum zstd
window; the actual size must match the declared one. MessagePack bounds the lengths of collections,
strings and binary; a malformed Socket.IO packet does not reach the handler.

`requestBytes`, `responseBytes`, event sizes and stream credit still apply to the
original UTF-8/binary data. Compression does not permit exceeding these limits. JSON envelope budgets
on Unix HTTP remain separate bounds. A change of encoding requires a new runtime release
and a coordinated update of brokers and agents: mixed versions are not supported.

## Accounting

The node publisher builds one validated EventPublish (UTF-8 → base64), which is handed to the local
source and to all broker lanes. No lane re-encodes the owner text. At the binary codec boundary
base64 is converted to bytes and back according to the internal contract; there is no cache of
arbitrary bodies. Event queue byte accounting counts the length of the canonical base64 plus the
serialized small envelope: base64 is ASCII without JSON escaping. Metadata, gaps and errors are
counted as ordinary JSON, including Unicode/escape. Input schemas check canonical base64 and the
decoded length before the queue.

`bun run benchmark:events` separately measures publication preparation for local + two lanes
and exact queue accounting on synthetic payloads. It does not measure the CPU of the whole service
or the network.

The broker writes `lane-volume` into the existing bounded audit journal. A record holds the shared
`connection`, `nodeId` and up to 64 `rows` elements. Each element holds `direction`, `event`,
`service`, `topic`, `frames`, `compressedFrames`, `encodedBytes`, `decodedBytes`, `startedAt`,
`endedAt`. `laneVolumeRows` expands a record into complete logical groups. Inbound is measured after
decoding the packet actually accepted, outbound in Engine.IO `packetCreate`. The body itself never
reaches the journal.

`frames` counts logical packets, each consisting of a header and an attachment.
`encodedBytes` is the sum of the Socket.IO header and the binary attachment with the codec header
after compression. `decodedBytes` is the MessagePack size before compression. These are exact
codec-level bytes, not a network interface counter: WebSocket headers, polling base64/HTTP,
heartbeat, TLS, TCP and network retransmissions are not included. A sent packet does not prove
application delivery; that is determined by the ordinary acknowledgement and delivery semantics.
The handshake before the connection is admitted and frames rejected by the decoder are not included.
`socket:3` denotes an acknowledgement without domain attribution. Other control packets without
a binary attachment are not included.

Service responses are linked to the request by connection and request id; stream chunks by stream id.
The cache is bounded to 4096 entries and 16 minutes, a group to 1024 rows. Missing or evicted
attribution yields `service: null`, but the bytes remain counted. Data is flushed every 60 seconds
even on a quiet connection, when the table fills and on disconnect. The limits and losses of the
journal itself are visible in the existing audit diagnostics.

Timestamps are kept numeric until the flush and converted to ISO once per group boundary.
Packing the metrics does not change the flush frequency and does not merge `service`, `call`,
`result`, `event-publish` decisions or refusals. An audit reader uses `LaneVolumeSchema` and walks
`rows`; the current writer has no old flat format.

## Verification

`bun run benchmark:lane` compares JSON, JSON+deflate, JSON+zstd and the binary codec on
deterministic synthetic documents of 1200, 2400, 80000 and 326216 bytes. The output contains
size and measured encode+decode CPU time; it is not a measurement of production load.

`bun run benchmark:background` measures fleet polls, declaration reads, packet accounting,
event-loop samples and metric writes into a real journal on synthetic data. Seven rounds
after warm-up give the median CPU and wall time. The journal size includes the envelope; absence of
losses is checked by the frame count, the writer status and its refusals. It is not a speed-up
percentage of the whole process or of end-to-end RPC.

`test/lane-compression.test.ts` checks SDK → Unix door → agent → broker → agent → owner
and the reverse path, both sides of accounting, refusal at `responseBytes + 1` and lossless event
delivery. `test/lane-codec.test.ts` checks the absence of escaping/base64 overhead, incompressible
data, the decoded frame boundary, a compression bomb, corrupted packets and decoder independence from
history. The ordinary stream/reconnect/cancellation tests use the same production codec.
