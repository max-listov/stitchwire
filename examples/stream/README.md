# Bounded stream

Run `bun run example:stream`. The shared synthetic harness starts two brokers and two agents,
executes an operator-fixed producer (not a caller-provided script), reads a finite line and cancels
a silent producer. The profile caps output at 4096 bytes and execution at two seconds.

Stream credits are transport policy. A slow reader must not create an unbounded queue. The
maintained `test/stream.test.ts` covers credit exhaustion, slow-consumer refusal and process cleanup;
the packed SDK gate separately measures stalled-reader buffering on Node and Bun. Silence is not
EOF. Use an AbortSignal or close the feed; do not implement an inactivity retry loop.

Stream cursors belong to the producer. Wire forwards an allowed opaque cursor and reports terminal
outcomes; it neither interprets it nor supplies a durable journal.
