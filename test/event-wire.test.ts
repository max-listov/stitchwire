import { afterAll, describe, expect, test } from 'bun:test';
import type { EventDeliveryAck } from '../packages/contracts/src/protocol/event.ts';
import type { EventDelivery } from '../packages/runtime/src/node/event-consumer.ts';
import { type EventStand, nextFrame, startEventStand, TOPIC } from './event-stand.ts';
import { RAW_REQUEST_TIMEOUT_MS, type RawLane, rawLane } from './raw-lane.ts';
import { acknowledgeEach, brokerHealth, until, waitConnected } from './support.ts';

/**
 * The event plane as its two ends meet it: a producer agent publishing and declaring, a broker
 * between them, and reader agents holding subscriptions. Nothing asserts how long anything took.
 */

describe('a producer that stops declaring a topic', () => {
  let stand: EventStand | undefined;
  afterAll(async () => {
    await stand?.stop();
  });

  test('frees its subscribers’ slots, and they resume when it declares the topic again', async () => {
    stand = await startEventStand(['reader']);
    const reader = stand.reader('reader');
    expect(await stand.declared('')).toBe(true);
    await waitConnected(reader);
    const feed = reader.subscribeEvents({ topic: TOPIC, resume: null });
    const boot = crypto.randomUUID();
    let seq = 0;
    let heard: EventDelivery | 'timeout' = 'timeout';
    for (let attempt = 0; heard === 'timeout' && attempt < 15; attempt += 1) {
      await stand.publish(boot, seq++);
      heard = await nextFrame(feed, 1_000);
    }
    expect(heard).toMatchObject({ topic: TOPIC });
    const { port } = stand;
    expect((await brokerHealth(port)).events.subscriptions).toBe(1);

    const before = await stand.declaredAt();
    stand.withdraw();
    expect(await stand.declared(before)).toBe(true);

    // The reader is told the producer is gone and asks again; asking about a topic nobody declares
    // is refused, so the broker holds no slot for it while the topic is undeclared.
    expect(await until(async () => (await brokerHealth(port)).events.subscriptions === 0)).toBe(true);

    // The producer declares the topic again: the reader's own retry finds it, and the same feed
    // hears the next boot's events without the reader having done anything.
    const restored = await stand.declaredAt();
    stand.describe(['reader']);
    expect(await stand.declared(restored)).toBe(true);
    const next = crypto.randomUUID();
    let afterwards: EventDelivery | 'timeout' = 'timeout';
    for (
      let attempt = 0;
      attempt < 30 && !(typeof afterwards === 'object' && 'seq' in afterwards && afterwards.bootId === next);
      attempt += 1
    ) {
      await stand.publish(next, attempt);
      afterwards = await nextFrame(feed, 1_000);
    }
    expect(afterwards).toMatchObject({ bootId: next, topic: TOPIC });
    await feed.return?.();
  }, 60_000);
});

describe('a producer that starts a new boot', () => {
  let stand: EventStand | undefined;
  let lane: RawLane | undefined;
  afterAll(async () => {
    lane?.close();
    await stand?.stop();
  });

  test('is heard as events by a subscriber that overflowed in the old boot, behind a boundary naming the old high-water', async () => {
    stand = await startEventStand(['reader']);
    // One event in flight and two in the broker's queue: a subscriber that acknowledges nothing
    // leaves every later event of the boot to overflow.
    stand.describe(['reader'], { queueDepth: 2 });
    expect(await stand.declared('')).toBe(true);
    lane = await rawLane(stand.port, 'reader', stand.token('reader'));
    const held: Array<{ delivery: unknown; acknowledge: (ack: EventDeliveryAck) => void }> = [];
    for (const event of ['event:event', 'event:gap', 'event:error'] as const)
      lane.client.on(event, (delivery, acknowledge) => held.push({ delivery, acknowledge }));
    const subscribed = await lane.client.request(
      'event:subscribe',
      { subscriptionId: crypto.randomUUID(), topic: TOPIC, subscriber: 'reader', resume: null },
      { timeoutMs: RAW_REQUEST_TIMEOUT_MS },
    );
    expect(subscribed.ok).toBe(true);

    const first = crypto.randomUUID();
    for (let seq = 0; seq < 8; seq += 1) expect((await stand.publish(first, seq)).ok).toBe(true);
    expect(await until(() => held.length === 1)).toBe(true);

    const second = crypto.randomUUID();
    expect((await stand.publish(second, 0)).ok).toBe(true);

    // The subscriber now acknowledges what it was handed, one delivery at a time, and what follows
    // is everything the broker still owes it: the old boot's event, the boundary, the new boot's.
    await acknowledgeEach(held, 3);
    const heard = held.map(({ delivery }) => delivery);
    expect(heard).toMatchObject([
      { bootId: first, seq: 0 },
      // The producer's high-water of the old boot is named, so the tail dropped with it is derivable.
      { reason: 'boot-change', bootId: first, fromSeq: 7, toSeq: 7, nextBootId: second },
      { bootId: second, seq: 0 },
    ]);
    expect(heard).toHaveLength(3);
  }, 60_000);
});
