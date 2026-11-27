/**
 * Resume: what a subscriber is told when it comes back.
 *
 * The contract under test is one sentence — the broker tells the truth about what happened while
 * the subscriber was away and never pretends to have it — so every case here is really the same
 * question asked from a different starting point: is the answer honest, is it immediate, and does
 * it name itself correctly.
 */

import { describe, expect, test } from 'bun:test';
import { EventRouter, type EventSink } from '../packages/runtime/src/broker/events.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { ResilientLaneEventIterator } from '../packages/runtime/src/node/lane-event-iterator.ts';
import type { EventDelivery } from '../packages/runtime/src/node/event-consumer.ts';
import { MultiHomeEventConsumer } from '../packages/runtime/src/node/multi-home-events.ts';
import { EventPublishSchema, type EventSubscribe } from '../packages/contracts/src/protocol/event.ts';
import { brokerConfig, delivered } from './support.ts';

const TOKEN_P = 'u'.repeat(40);
const TOKEN_S = 'v'.repeat(40);
const BOOT = crypto.randomUUID();

function config(overrides: Record<string, unknown> = {}) {
  return brokerConfig(
    { publisher: TOKEN_P, subscriber: TOKEN_S },
    {
      topics: {
        'generic.events': {
          producer: 'publisher',
          subscribers: ['subscriber'],
          delivery: 'ordered',
          ...overrides,
        },
      },
    },
  );
}

function publish(seq: number, bootId = BOOT, data = `event-${seq}`) {
  return EventPublishSchema.parse({
    topic: 'generic.events',
    producer: 'publisher',
    bootId,
    seq,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: Buffer.from(data).toString('base64'),
    bytes: Buffer.byteLength(data),
  });
}

function subscription(resume: EventSubscribe['resume'] = null): EventSubscribe {
  return {
    subscriptionId: crypto.randomUUID(),
    topic: 'generic.events',
    subscriber: 'subscriber',
    resume,
  };
}

type Delivered = Parameters<EventSink['deliver']>[1];

function recorder(): { deliveries: Delivered[]; sink: EventSink } {
  const deliveries: Delivered[] = [];
  return {
    deliveries,
    sink: {
      deliver: (_socket, delivery, ack) => {
        deliveries.push(delivery);
        ack({ accepted: true, refusal: 'none', detail: '' });
      },
    },
  };
}

/** `kind:seq` for events, `gap:reason:from..to` for gaps — the shape of the answer in one line. */
function shape(deliveries: Delivered[]): string[] {
  return deliveries.map((item) => {
    if (item.kind === 'event') return `event:${item.value.seq}`;
    if (item.kind === 'gap') return `gap:${item.value.reason}:${item.value.fromSeq}..${item.value.toSeq}`;
    return `error:${item.value.failure}`;
  });
}

const RETAINING = { retain: { maxAgeMs: 60_000, maxBytes: 4_096 } };

describe('resume without retention', () => {
  test('a topic that retains nothing behaves exactly as before for a subscriber that claims nothing', async () => {
    const { deliveries, sink } = recorder();
    const router = new EventRouter(config(), sink);
    router.publish('publisher', publish(0), 'publisher-socket');
    router.publish('publisher', publish(1), 'publisher-socket');
    router.subscribe(subscription(), 'subscriber-socket');
    // Absence: nothing to wait FOR, so the clock is the only instrument here.
    await Bun.sleep(30);
    // Nothing before the subscription, no gap invented for it: a first subscription starts live.
    expect(deliveries).toEqual([]);
    router.publish('publisher', publish(2), 'publisher-socket');
    await delivered(deliveries, 1);
    expect(shape(deliveries)).toEqual(['event:2']);
  });

  test('a returning subscriber is told the exact range immediately, without waiting for the next event', async () => {
    const { deliveries, sink } = recorder();
    const router = new EventRouter(config(), sink);
    for (let seq = 0; seq <= 4; seq += 1) router.publish('publisher', publish(seq), 'publisher-socket');
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 1 }), 'subscriber-socket');
    await delivered(deliveries, 1);
    // The topic is silent from here on, and the answer still arrived: that is the whole point.
    expect(shape(deliveries)).toEqual(['gap:resume:2..4']);
  });

  test('a cursor already at the head produces silence, because continuity is proven', async () => {
    const { deliveries, sink } = recorder();
    const router = new EventRouter(config(), sink);
    for (let seq = 0; seq <= 2; seq += 1) router.publish('publisher', publish(seq), 'publisher-socket');
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 2 }), 'subscriber-socket');
    // Absence: nothing to wait FOR, so the clock is the only instrument here.
    await Bun.sleep(30);
    expect(deliveries).toEqual([]);
  });

  test('a cursor ahead of this broker is ordinary on a second lane and produces silence', async () => {
    const { deliveries, sink } = recorder();
    const router = new EventRouter(config(), sink);
    router.publish('publisher', publish(0), 'publisher-socket');
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 9 }), 'subscriber-socket');
    // Absence: nothing to wait FOR, so the clock is the only instrument here.
    await Bun.sleep(30);
    expect(deliveries).toEqual([]);
  });

  test('with no producer epoch the gap sits ON the cursor, so a reconnect loop cannot walk it forward', async () => {
    const { deliveries, sink } = recorder();
    const router = new EventRouter(config(), sink);
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 7 }), 'subscriber-socket');
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 7 }), 'second-socket');
    await delivered(deliveries, 2);
    expect(shape(deliveries)).toEqual(['gap:resume:7..7', 'gap:resume:7..7']);
  });

  test('a producer that restarted while the subscriber slept ends the epoch instead of renumbering it', async () => {
    const { deliveries, sink } = recorder();
    const router = new EventRouter(config(), sink);
    router.publish('publisher', publish(0), 'publisher-socket');
    const second = crypto.randomUUID();
    router.publish('publisher', publish(0, second), 'publisher-socket');
    router.publish('publisher', publish(1, second), 'publisher-socket');
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 0 }), 'subscriber-socket');
    await delivered(deliveries, 1);
    expect(shape(deliveries)).toEqual(['gap:boot-change:0..0']);
  });
});

describe('resume with retention', () => {
  test('a subscriber back inside the window is handed the missed frames in order and no gap', async () => {
    const { deliveries, sink } = recorder();
    const router = new EventRouter(config(RETAINING), sink);
    for (let seq = 0; seq <= 4; seq += 1) router.publish('publisher', publish(seq), 'publisher-socket');
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 1 }), 'subscriber-socket');
    await delivered(deliveries, 3);
    expect(shape(deliveries)).toEqual(['event:2', 'event:3', 'event:4']);
  });

  test('catch-up joins the live stream without a seam', async () => {
    const { deliveries, sink } = recorder();
    const router = new EventRouter(config(RETAINING), sink);
    for (let seq = 0; seq <= 2; seq += 1) router.publish('publisher', publish(seq), 'publisher-socket');
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 0 }), 'subscriber-socket');
    router.publish('publisher', publish(3), 'publisher-socket');
    await delivered(deliveries, 3);
    expect(shape(deliveries)).toEqual(['event:1', 'event:2', 'event:3']);
  });

  test('a subscriber back past the window gets the lost head named `retention`, then the covered tail', async () => {
    const { deliveries, sink } = recorder();
    // Two events fit; the third evicts the first.
    const router = new EventRouter(config({ retain: { maxAgeMs: 60_000, maxBytes: 16 } }), sink);
    for (let seq = 0; seq <= 3; seq += 1) router.publish('publisher', publish(seq), 'publisher-socket');
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 0 }), 'subscriber-socket');
    await delivered(deliveries, 3);
    expect(shape(deliveries)).toEqual(['gap:retention:1..1', 'event:2', 'event:3']);
  });

  test('age evicts even while bytes are nowhere near the bound', async () => {
    const { deliveries, sink } = recorder();
    // The window has to be wide enough that the SURVIVING event is still inside it when the
    // assertion runs, and narrow enough that the older two are not. A one-millisecond window met
    // neither on a loaded machine: the event meant to survive aged out before the subscribe.
    const router = new EventRouter(config({ retain: { maxAgeMs: 200, maxBytes: 4_096 } }), sink);
    router.publish('publisher', publish(0), 'publisher-socket');
    router.publish('publisher', publish(1), 'publisher-socket');
    await Bun.sleep(250);
    router.publish('publisher', publish(2), 'publisher-socket');
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 0 }), 'subscriber-socket');
    await delivered(deliveries, 2);
    expect(shape(deliveries)).toEqual(['gap:retention:1..1', 'event:2']);
  });

  test('a ring standing still still ages: the window is checked at resume, not only at publish', async () => {
    const { deliveries, sink } = recorder();
    const router = new EventRouter(config({ retain: { maxAgeMs: 10, maxBytes: 4_096 } }), sink);
    router.publish('publisher', publish(0), 'publisher-socket');
    router.publish('publisher', publish(1), 'publisher-socket');
    await Bun.sleep(40);
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 0 }), 'subscriber-socket');
    await delivered(deliveries, 1);
    expect(shape(deliveries)).toEqual(['gap:retention:1..1']);
  });

  test("replay is capped by the subscriber's own queue, and the excess is a gap rather than an overflow", async () => {
    const { deliveries, sink } = recorder();
    const router = new EventRouter(config({ ...RETAINING, queueDepth: 2 }), sink);
    for (let seq = 0; seq <= 5; seq += 1) router.publish('publisher', publish(seq), 'publisher-socket');
    router.subscribe(subscription({ bootId: BOOT, afterSeq: 0 }), 'subscriber-socket');
    await delivered(deliveries, 3);
    expect(shape(deliveries)).toEqual(['gap:retention:1..3', 'event:4', 'event:5']);
  });

  test('a new producer boot drops the ring: the previous epoch is never replayed under new numbering', async () => {
    const { deliveries, sink } = recorder();
    const router = new EventRouter(config(RETAINING), sink);
    for (let seq = 0; seq <= 2; seq += 1) router.publish('publisher', publish(seq), 'publisher-socket');
    const second = crypto.randomUUID();
    router.publish('publisher', publish(0, second), 'publisher-socket');
    router.subscribe(subscription({ bootId: second, afterSeq: -1 + 1 }), 'subscriber-socket');
    // Absence: nothing to wait FOR, so the clock is the only instrument here.
    await Bun.sleep(30);
    // The cursor is the new boot's sequence 0, which is also its head: nothing to say.
    expect(deliveries).toEqual([]);
  });

  test('health reports the declared window beside what is actually in it', () => {
    const { sink } = recorder();
    const router = new EventRouter(config(RETAINING), sink);
    expect(router.topics(Date.now())[0]?.retention).toEqual({
      maxAgeMs: 60_000,
      maxBytes: 4_096,
      events: 0,
      bytes: 0,
      oldestAgeMs: null,
    });
    router.publish('publisher', publish(0), 'publisher-socket');
    const flow = router.topics(Date.now())[0]?.retention;
    expect(flow?.events).toBe(1);
    expect(flow?.bytes).toBe(7);
    expect(flow?.oldestAgeMs).not.toBeNull();
  });

  test('a topic without retention reports null rather than an empty window', () => {
    const { sink } = recorder();
    const router = new EventRouter(config(), sink);
    expect(router.topics(Date.now())[0]?.retention).toBeNull();
  });
});

describe('retention configuration refuses what it cannot mean', () => {
  test('half a pair is refused, because it reads as on and behaves as off', () => {
    expect(() => config({ retain: { maxAgeMs: 60_000, maxBytes: 0 } })).toThrow();
    expect(() => config({ retain: { maxAgeMs: 0, maxBytes: 4_096 } })).toThrow();
  });

  test('a latest-wins topic cannot retain', () => {
    expect(() => config({ delivery: 'latest-wins', ...RETAINING })).toThrow();
  });

  test('the rings added together may not exceed the broker ceiling', () => {
    expect(() =>
      brokerConfig(
        { publisher: TOKEN_P, subscriber: TOKEN_S },
        {
          admission: { maxRetainedBytesTotal: 4_096 },
          topics: {
            'a.events': {
              producer: 'publisher',
              subscribers: ['subscriber'],
              delivery: 'ordered',
              retain: { maxAgeMs: 60_000, maxBytes: 4_096 },
            },
            'b.events': {
              producer: 'publisher',
              subscribers: ['subscriber'],
              delivery: 'ordered',
              retain: { maxAgeMs: 60_000, maxBytes: 4_096 },
            },
          },
        },
      ),
    ).toThrow();
  });

  test('both zero is the default and is accepted', () => {
    expect(config().topics['generic.events']?.retain).toEqual({ maxAgeMs: 0, maxBytes: 0 });
  });
});

/** One lane, driven by hand, so the merge rules can be tested without a broker. */
function lane(items: EventDelivery[]): AsyncIterableIterator<EventDelivery> {
  let index = 0;
  const iterator: AsyncIterableIterator<EventDelivery> = {
    next: async () => {
      const value = items[index];
      index += 1;
      if (value === undefined) {
        await Bun.sleep(5);
        return { done: true, value: undefined };
      }
      return { done: false, value };
    },
    return: async () => ({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator,
  };
  return iterator;
}

function frame(seq: number, bootId = BOOT) {
  return { ...publish(seq, bootId), subscriptionId: crypto.randomUUID() };
}

function gap(from: number, to: number, reason: 'resume' | 'boot-change', bootId = BOOT, nextBootId?: string) {
  return {
    subscriptionId: crypto.randomUUID(),
    topic: 'generic.events',
    producer: 'publisher' as const,
    bootId,
    fromSeq: from,
    toSeq: to,
    reason,
    ...(nextBootId === undefined ? {} : { nextBootId }),
  };
}

async function drain(consumer: MultiHomeEventConsumer): Promise<string[]> {
  const seen: string[] = [];
  for await (const delivery of consumer) {
    if ('failure' in delivery) break;
    if ('subscriptionState' in delivery) continue;
    seen.push(
      'seq' in delivery
        ? `event:${delivery.seq}`
        : `gap:${delivery.reason}:${delivery.fromSeq}..${delivery.toSeq}`,
    );
  }
  return seen;
}

describe('merging resume answers across lanes', () => {
  test('a resume gap at the cursor is passed on but does not move it', async () => {
    const consumer = new MultiHomeEventConsumer(
      crypto.randomUUID(),
      'generic.events',
      [{ id: 'a', iterator: lane([frame(3), gap(3, 3, 'resume'), frame(4)]) }],
      16,
    );
    // Without the re-anchor rule the gap would be dropped as stale; without leaving the cursor put,
    // sequence 4 would later be discarded as already-seen.
    expect(await drain(consumer)).toEqual(['event:3', 'gap:resume:3..3', 'event:4']);
  });

  test('a boot change learned late still switches the epoch and names the missed head', async () => {
    const second = crypto.randomUUID();
    const consumer = new MultiHomeEventConsumer(
      crypto.randomUUID(),
      'generic.events',
      [
        {
          id: 'a',
          iterator: lane([
            frame(2),
            gap(2, 2, 'boot-change', BOOT, second),
            frame(5, second),
            frame(6, second),
          ]),
        },
      ],
      16,
    );
    // The old rule accepted only sequence zero of a new boot, which wedged the topic forever once
    // the broker answered a resume with a boot change the producer had already run past.
    expect(await drain(consumer)).toEqual([
      'event:2',
      'gap:boot-change:2..2',
      'gap:resume:0..4',
      'event:5',
      'event:6',
    ]);
  });
});

describe('a lane that reconnects where it stopped', () => {
  /** A lane that hands over its scripted deliveries and then dies, exactly as a dropped socket does. */
  function laneAgent(scripts: EventDelivery[][]): {
    agent: Pick<Agent, 'connected' | 'subscribeEvents'> & { terminal: boolean };
    asked: Array<EventSubscribe['resume']>;
  } {
    const asked: Array<EventSubscribe['resume']> = [];
    let attempt = 0;
    const agent = {
      connected: true,
      terminal: false,
      subscribeEvents: (request: { resume: EventSubscribe['resume'] }) => {
        asked.push(request.resume);
        const items = scripts[attempt] ?? [];
        attempt += 1;
        return lane([
          ...items,
          {
            subscriptionId: crypto.randomUUID(),
            topic: 'generic.events',
            from: 'broker' as const,
            failure: 'transport' as const,
            refusal: 'none' as const,
            retryAfterMs: null,
            transportCause: 'lane-lost-after-dispatch' as const,
            detail: 'lane dropped',
          },
        ]);
      },
    };
    return { agent, asked };
  }

  test('the second subscribe carries the cursor the first one reached', async () => {
    const { agent, asked } = laneAgent([[frame(0), frame(1)], [frame(2)]]);
    const iterator = new ResilientLaneEventIterator(agent, { topic: 'generic.events', resume: null });
    for (let taken = 0; taken < 3; taken += 1) await iterator.next();
    await iterator.return();
    // First attempt claims nothing; the reconnect claims sequence 1, which is what it actually saw.
    expect(asked[0]).toBeNull();
    expect(asked[1]).toEqual({ bootId: BOOT, afterSeq: 1 });
  });

  test('a gap advances the cursor too — those sequences are accounted for, as lost', async () => {
    const { agent, asked } = laneAgent([[frame(0), gap(1, 4, 'resume')], [frame(5)]]);
    const iterator = new ResilientLaneEventIterator(agent, { topic: 'generic.events', resume: null });
    for (let taken = 0; taken < 3; taken += 1) await iterator.next();
    await iterator.return();
    expect(asked[1]).toEqual({ bootId: BOOT, afterSeq: 4 });
  });

  test('a consumer-supplied cursor is used for the very first subscribe', async () => {
    const { agent, asked } = laneAgent([[frame(9)]]);
    const iterator = new ResilientLaneEventIterator(agent, {
      topic: 'generic.events',
      resume: { bootId: BOOT, afterSeq: 8 },
    });
    await iterator.next();
    await iterator.return();
    expect(asked[0]).toEqual({ bootId: BOOT, afterSeq: 8 });
  });

  test('a new producer boot resets the cursor instead of carrying a sequence across epochs', async () => {
    const second = crypto.randomUUID();
    const { agent, asked } = laneAgent([[frame(7), frame(0, second)], [frame(1, second)]]);
    const iterator = new ResilientLaneEventIterator(agent, { topic: 'generic.events', resume: null });
    for (let taken = 0; taken < 3; taken += 1) await iterator.next();
    await iterator.return();
    expect(asked[1]).toEqual({ bootId: second, afterSeq: 0 });
  });
});

describe('one resume answer per wake', () => {
  test('two lanes answering the same resume reach the consumer once', async () => {
    const consumer = new MultiHomeEventConsumer(
      crypto.randomUUID(),
      'generic.events',
      [
        { id: 'lane-a', iterator: lane([gap(3, 9, 'resume'), frame(10)]) },
        { id: 'lane-b', iterator: lane([gap(3, 9, 'resume')]) },
      ],
      16,
    );
    const seen = await drain(consumer);
    // Both brokers answer honestly and identically; passing both on would cost a second snapshot
    // for one wake, which is what the contract tells the consumer to take on every gap.
    expect(seen.filter((item) => item === 'gap:resume:3..9')).toHaveLength(1);
    expect(seen).toContain('event:10');
  });

  test('the same lane saying it twice is not an echo', async () => {
    const consumer = new MultiHomeEventConsumer(
      crypto.randomUUID(),
      'generic.events',
      [{ id: 'lane-a', iterator: lane([gap(3, 3, 'resume'), gap(3, 3, 'resume')]) }],
      16,
    );
    // One lane repeating itself means it really happened twice — two reconnects on a dead topic.
    expect(await drain(consumer)).toEqual(['gap:resume:3..3', 'gap:resume:3..3']);
  });

  test('a delivery between the two ends the window, so a later repeat is not swallowed', async () => {
    const consumer = new MultiHomeEventConsumer(
      crypto.randomUUID(),
      'generic.events',
      [
        { id: 'lane-a', iterator: lane([gap(3, 9, 'resume'), frame(10)]) },
        { id: 'lane-b', iterator: lane([]) },
      ],
      16,
    );
    const first = await drain(consumer);
    expect(first).toEqual(['gap:resume:3..9', 'event:10']);
  });
});
