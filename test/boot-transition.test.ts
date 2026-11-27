import { expect, test } from 'bun:test';
import type { EventDelivery } from '../packages/runtime/src/node/event-consumer.ts';
import { LocalEventLane } from '../packages/runtime/src/node/local-events.ts';
import { MultiHomeEventConsumer } from '../packages/runtime/src/node/multi-home-events.ts';
import type { EventFrame, EventGap } from '../packages/contracts/src/protocol/event.ts';

class Source implements AsyncIterableIterator<EventDelivery> {
  queue: EventDelivery[] = [];
  waiting: ((r: IteratorResult<EventDelivery>) => void) | undefined;
  push(value: EventDelivery) {
    if (this.waiting) {
      this.waiting({ done: false, value });
      this.waiting = undefined;
    } else this.queue.push(value);
  }
  next(): Promise<IteratorResult<EventDelivery>> {
    const value = this.queue.shift();
    return value
      ? Promise.resolve({ done: false, value })
      : new Promise((resolve) => {
          this.waiting = resolve;
        });
  }
  async return(): Promise<IteratorResult<EventDelivery>> {
    this.waiting?.({ done: true, value: undefined });
    return { done: true, value: undefined };
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}
const id = crypto.randomUUID();
const a = crypto.randomUUID(),
  b = crypto.randomUUID(),
  c = crypto.randomUUID();
function frame(bootId: string, seq: number): EventFrame {
  return {
    subscriptionId: id,
    topic: 'generic.boot',
    producer: 'worker',
    bootId,
    seq,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: 'e30=',
    bytes: 2,
  };
}
function gap(bootId: string, nextBootId: string, seq: number): EventGap & { nextBootId: string } {
  return {
    subscriptionId: id,
    topic: 'generic.boot',
    producer: 'worker',
    bootId,
    nextBootId,
    fromSeq: seq,
    toSeq: seq,
    reason: 'boot-change',
  };
}
const next = (merge: MultiHomeEventConsumer) =>
  Promise.race([merge.next().then((r) => r.value), Bun.sleep(100).then(() => null)]);

test('boot marker behind local high-water does not wedge; successor identity excludes late retired epochs', async () => {
  for (const marker of [9, 10, 12]) {
    const left = new Source(),
      right = new Source();
    const merge = new MultiHomeEventConsumer(
      id,
      'generic.boot',
      [
        { id: 'left', iterator: left },
        { id: 'right', iterator: right },
      ],
      16,
    );
    try {
      left.push(frame(a, 10));
      expect(await next(merge)).toMatchObject({ bootId: a, seq: 10 });
      right.push(gap(a, b, marker));
      expect(await next(merge)).toMatchObject({ bootId: a, reason: 'boot-change' });
      right.push(frame(b, 3));
      expect(await next(merge)).toMatchObject({ bootId: b, reason: 'resume', fromSeq: 0, toSeq: 2 });
      expect(await next(merge)).toMatchObject({ bootId: b, seq: 3 });
      left.push(gap(a, b, 9));
      left.push(frame(a, 11));
      right.push(gap(b, c, 3));
      expect(await next(merge)).toMatchObject({ bootId: b, reason: 'boot-change' });
      left.push(frame(a, 12));
      right.push(frame(c, 0));
      expect(await next(merge)).toMatchObject({ bootId: c, seq: 0 });
      right.push(frame(c, 0));
      left.push(gap(b, c, 3));
      right.push(frame(c, 1));
      expect(await next(merge)).toMatchObject({ bootId: c, seq: 1 });
    } finally {
      await merge.return();
    }
  }
});

test('local lane supplies a boot boundary even without any broker or after a dropped frame', async () => {
  const local = new LocalEventLane(
    id,
    1,
    () => {},
    () => {},
  );
  local.push(frame(a, 10));
  expect((await local.next()).value).toMatchObject({ bootId: a, seq: 10 });
  local.push(frame(b, 0));
  local.push(frame(b, 1));
  expect((await local.next()).value).toMatchObject({ bootId: a, nextBootId: b, reason: 'boot-change' });
  expect((await local.next()).value).toMatchObject({ bootId: b, seq: 0 });
  local.push(frame(b, 2));
  expect((await local.next()).value).toMatchObject({ bootId: b, seq: 2 });
  await local.return();
});

test('conflicting skipped-boot boundaries produce explicit resync failure, never an arbitrary rewind or silent wedge', async () => {
  const left = new Source(),
    right = new Source();
  const merge = new MultiHomeEventConsumer(
    id,
    'generic.boot',
    [
      { id: 'a', iterator: left },
      { id: 'b', iterator: right },
    ],
    4,
  );
  left.push(frame(a, 10));
  await next(merge);
  left.push(gap(a, b, 9));
  expect(await next(merge)).toMatchObject({ nextBootId: b });
  right.push(gap(a, c, 10));
  expect(await next(merge)).toMatchObject({ failure: 'transport' });
  expect((await merge.next()).done).toBe(true);
  await merge.return();
});
