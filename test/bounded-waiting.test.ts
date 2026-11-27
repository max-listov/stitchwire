/**
 * A state with no deadline is indistinguishable from healthy waiting.
 *
 * Six defects of this class landed across two projects in one day, three of them here: a quiet
 * subscription that a runtime was severing on a schedule while it read as "subscribed and quiet";
 * `ok: true` from a check that never happened; and a terminal refusal collected but never handed
 * over because one source never ends. None was caught by a test, and the reason is structural —
 * every one is about the ABSENCE of a signal, while a test written by default asserts a presence.
 *
 * So these are written on purpose, and each asserts BOTH sides. A test that only proves the guard
 * fires passes just as happily on a mechanism that is broken outright and delivers nothing at all —
 * which is how the neighbouring project nearly shipped one of its own fixes.
 */

import { expect, test } from 'bun:test';
import { LocalEventBus, LocalEventLane } from '../packages/runtime/src/node/local-events.ts';
import { EventPublishSchema } from '../packages/contracts/src/protocol/event.ts';

const BOOT = crypto.randomUUID();

function frame(seq: number) {
  const data = `event-${seq}`;
  return EventPublishSchema.parse({
    topic: 'generic.events',
    producer: 'worker',
    bootId: BOOT,
    seq,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: Buffer.from(data).toString('base64'),
    bytes: data.length,
  });
}

test('a reader that keeps up receives everything — the side a guard-only test would not notice', async () => {
  const lane = new LocalEventLane(
    'sub',
    4,
    () => {},
    () => {},
  );
  const received: number[] = [];
  for (let seq = 0; seq < 3; seq += 1) lane.push({ ...frame(seq), subscriptionId: 'sub' });
  for (let index = 0; index < 3; index += 1) {
    const next = await lane.next();
    received.push((next.value as { seq: number }).seq);
  }
  expect(received).toEqual([0, 1, 2]);
  expect(lane.dropped).toBe(0);
});

test('a reader that stops reading does not grow the queue without bound', async () => {
  const lines: string[] = [];
  const lane = new LocalEventLane(
    'sub',
    4,
    () => {},
    (line) => lines.push(line),
  );
  for (let seq = 0; seq < 50; seq += 1) lane.push({ ...frame(seq), subscriptionId: 'sub' });

  // Bounded, and the overflow is announced once rather than discarded in silence — a silent drop is
  // this defect class wearing its other face.
  expect(lane.dropped).toBe(46);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain('buffer of 4 is full');
  expect(lines[0]).toContain('broker copy still carries this event');

  // And what it did keep is still delivered: the guard bounded the queue rather than breaking it.
  const first = await lane.next();
  expect((first.value as { seq: number }).seq).toBe(0);
});

test('overflow discards rather than blocking, so one slow local reader cannot stall a publish', async () => {
  const bus = new LocalEventBus();
  const slow = bus.open('generic.events', 'slow', 2);
  // Blocking here would push back on the publisher for the benefit of one local reader, turning a
  // latency optimisation into a fleet-wide stall.
  //
  // This used to assert a wall clock — `< 50 ms` for the loop — which measures how busy the machine
  // is, not what the code does: it failed at 111 ms on 2026-09-01 during a parallel test run while
  // the behaviour was perfectly correct. A microtask is the exact instrument for the actual claim.
  // Not yielding is precisely what "does not block" means, and it is true on any machine at any
  // load: if a single publish had awaited anything, the queued microtask would have run.
  let yielded = false;
  queueMicrotask(() => {
    yielded = true;
  });
  const started = performance.now();
  for (let seq = 0; seq < 200; seq += 1) bus.publish(frame(seq));
  expect(yielded).toBe(false);
  // And the instrument is checked against its own positive case, because `false` is also what a
  // microtask that never runs would report — a probe whose failure mode is indistinguishable from
  // the result it is asked for proves nothing on its own.
  await Promise.resolve();
  expect(yielded).toBe(true);
  // A generous ceiling stays as a catastrophe guard — quadratic fan-out would still be a defect —
  // but it is far from any plausible scheduling delay, so it cannot fail for being unlucky.
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(slow.dropped).toBeGreaterThan(0);
});

test('a closed lane stops accepting, and stops being published to', () => {
  const bus = new LocalEventBus();
  const lane = bus.open('generic.events', 'one', 8);
  expect(bus.publish(frame(0))).toBe(1);
  void lane.return();
  // Both sides: the registry forgets it, and the lane itself refuses anything that still arrives.
  expect(bus.publish(frame(1))).toBe(0);
  lane.push({ ...frame(2), subscriptionId: 'one' });
  expect(lane.dropped).toBe(0);
});

test('a waiting reader is handed the next frame directly, without touching the queue', async () => {
  const lane = new LocalEventLane(
    'sub',
    1,
    () => {},
    () => {},
  );
  const pending = lane.next();
  lane.push({ ...frame(7), subscriptionId: 'sub' });
  const delivered = await pending;
  expect((delivered.value as { seq: number }).seq).toBe(7);
  // The bound applies to what is BUFFERED, not to what is delivered: a reader that is present never
  // sees a drop, however small its buffer.
  expect(lane.dropped).toBe(0);
});
