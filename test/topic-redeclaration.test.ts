import { afterAll, describe, expect, test } from 'bun:test';
import type { EventDeliveryAck, EventPublish } from '../packages/contracts/src/protocol/event.ts';
import { EventDeclareSchema } from '../packages/contracts/src/protocol/topic.ts';
import type { EventDelivery as BrokerDelivery } from '../packages/runtime/src/broker/event-subscriptions.ts';
import { EventRouter } from '../packages/runtime/src/broker/events.ts';
import type { EventDelivery } from '../packages/runtime/src/node/event-consumer.ts';
import { type EventStand, nextFrame, startEventStand, TOPIC } from './event-stand.ts';
import { acknowledgeEach, brokerConfig, until, waitConnected } from './support.ts';

/**
 * An owner narrows who may read a topic by editing its own descriptor. What the broker granted under
 * the old declaration is judged again under the new one: a node the allowlist no longer names stops
 * receiving, the nodes it still names keep their subscriptions, and a descriptor the owner has
 * broken does not take back what its last good version declared.
 */

describe('through a broker and its agents', () => {
  let stand: EventStand | undefined;
  afterAll(async () => {
    await stand?.stop();
  });

  test('a node the new allowlist drops is refused by policy, the one it keeps still receives', async () => {
    stand = await startEventStand(['reader', 'other']);
    const { producer } = stand;
    const kept = stand.reader('reader');
    const dropped = stand.reader('other');
    expect(await stand.declared('')).toBe(true);
    await waitConnected(kept, dropped);
    const keptFeed = kept.subscribeEvents({ topic: TOPIC, resume: null });
    const droppedFeed = dropped.subscribeEvents({ topic: TOPIC, resume: null });

    const boot = crypto.randomUUID();
    let seq = 0;
    const publish = () => stand?.publish(boot, seq++);
    // Both subscriptions may still be in flight; publish until each has heard one frame.
    for (const feed of [keptFeed, droppedFeed]) {
      let frame: EventDelivery | 'timeout' = 'timeout';
      for (let attempt = 0; frame === 'timeout' && attempt < 15; attempt += 1) {
        await publish();
        frame = await nextFrame(feed, 1_000);
      }
      expect(frame).toMatchObject({ topic: TOPIC });
    }

    const before = (await producer.status()).events.declarations.lanes[0]?.declaredAt ?? '';
    stand.describe(['reader']);
    expect(await stand.declared(before)).toBe(true);

    // Everything published from now on is published to a topic the dropped node may no longer read.
    // The dropped node's feed must end with the refusal a new subscribe would get, whatever frames
    // were already in flight when the owner's edit arrived.
    let verdict: EventDelivery | 'timeout' = 'timeout';
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await publish();
      verdict = await nextFrame(droppedFeed, 1_000);
      if (verdict === 'timeout' || 'failure' in verdict) break;
    }
    expect(verdict).toMatchObject({ failure: 'denied', refusal: 'policy', topic: TOPIC });

    // The node the allowlist still names keeps its subscription and keeps receiving.
    let frame: EventDelivery | 'timeout' = 'timeout';
    for (let attempt = 0; frame === 'timeout' && attempt < 15; attempt += 1) {
      await publish();
      frame = await nextFrame(keptFeed, 1_000);
    }
    expect(frame).toMatchObject({ topic: TOPIC });
    await keptFeed.return?.();
    await droppedFeed.return?.();
  }, 90_000);
});

describe('through the event router', () => {
  const NODES = { worker: 'w'.repeat(40), a: 'a'.repeat(40), b: 'b'.repeat(40) };
  const config = brokerConfig(NODES, {
    topicNamespaces: { 'owner.': { producer: 'worker', subscribers: ['a', 'b'], maxTopics: 2 } },
  });
  const declare = (router: EventRouter, topic: Record<string, unknown>): ReturnType<EventRouter['declare']> =>
    router.declare('worker', EventDeclareSchema.parse({ producer: 'worker', topics: { 'owner.t': topic } }));
  const event = (bootId: string, seq: number): EventPublish => ({
    topic: 'owner.t',
    producer: 'worker',
    bootId,
    seq,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: 'eA==',
    bytes: 1,
  });
  const subscribe = (router: EventRouter, subscriber: string) =>
    router.subscribe(
      { subscriptionId: crypto.randomUUID(), topic: 'owner.t', subscriber, resume: null },
      `${subscriber}-socket`,
    );

  test('a smaller queue depth applies to a subscription that already exists', async () => {
    const held: Array<{ delivery: BrokerDelivery; acknowledge: (ack: EventDeliveryAck) => void }> = [];
    const router = new EventRouter(config, {
      deliver: (_socket, delivery, acknowledge) => held.push({ delivery, acknowledge }),
    });
    declare(router, { delivery: 'ordered', queueDepth: 4, subscribers: ['a', 'b'] });
    expect(subscribe(router, 'a').ok).toBe(true);
    const boot = crypto.randomUUID();
    expect(router.publish('worker', event(boot, 0), 'worker-socket').ok).toBe(true);
    // Event 0 is handed over and never acknowledged, so everything after it waits in the queue.
    expect(await until(() => held.length === 1)).toBe(true);

    declare(router, { delivery: 'ordered', queueDepth: 2, subscribers: ['a'] });
    for (let seq = 1; seq <= 5; seq++) router.publish('worker', event(boot, seq), 'worker-socket');

    await acknowledgeEach(held, 4);
    const heard = held.map(({ delivery }) =>
      delivery.kind === 'event'
        ? `event:${delivery.value.seq}`
        : delivery.kind === 'gap'
          ? `gap:${delivery.value.reason}:${delivery.value.fromSeq}-${delivery.value.toSeq}`
          : 'error',
    );
    expect(heard).toEqual(['event:0', 'event:1', 'event:2', 'gap:overflow:3-5']);
    router.stop();
  });

  test('a subscription whose queue the new declaration outgrows is told to subscribe again', async () => {
    const delivered: BrokerDelivery[] = [];
    const router = new EventRouter(config, { deliver: (_socket, delivery) => delivered.push(delivery) });
    declare(router, { delivery: 'ordered', queueDepth: 2, subscribers: ['a', 'b'] });
    expect(subscribe(router, 'a').ok).toBe(true);
    expect(router.status().subscriptions).toBe(1);

    declare(router, { delivery: 'ordered', queueDepth: 8, subscribers: ['a', 'b'] });
    expect(router.status().subscriptions).toBe(0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      kind: 'error',
      value: { failure: 'offline', transportCause: 'target-offline', topic: 'owner.t' },
    });
    // The answer is the one a not-yet-declared topic gives, so the subscriber asks again and is admitted.
    expect(subscribe(router, 'a').ok).toBe(true);
    router.stop();
  });
});
