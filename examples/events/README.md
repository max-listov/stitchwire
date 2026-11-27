# Volatile events and explicit gaps

Run `bun run example:events`. The synthetic two-broker harness publishes three events into a
1024-byte / 10-second retention ring. A returning subscriber observes an explicit retention gap
and the surviving event. A separate quiet subscription is cancelled by its supplied signal.

Retention is opt-in and memory-only, not durable history. `latest-wins` coalesces pending values;
it does not promise a retained snapshot for a new subscriber and cannot be combined with ordered
retention. A service needing durable resync supplies its own snapshot/journal and domain cursor.
`test/event.test.ts` separately checks coalescing, overflow, boot changes and reconnect limits.

Two lanes improve reachability but do not prove exactly-once execution or clock-based RTT. The
first accepted publication ACK settles the caller; an unreadable ACK leaves delivery unknown.
Never blindly retry a publish just because the caller timed out.
