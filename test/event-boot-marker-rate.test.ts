import { expect, test } from 'bun:test';
import type { EventPublish } from '../packages/contracts/src/protocol/event.ts';
import type { EventDelivery } from '../packages/runtime/src/broker/event-subscriptions.ts';
import { EventRouter } from '../packages/runtime/src/broker/events.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { settle, until } from './support.ts';

/**
 * A subscriber hears a boot boundary only together with an accepted event of the new boot. A
 * producer that starts a boot per event is held to the topic rate on what its subscribers receive
 * too, not only on what the broker accepts.
 */

const config = BrokerConfigSchema.parse({
  nodes: [
    { id: 'worker', tokenSha256s: [sha256('w'.repeat(40))] },
    { id: 'reader', tokenSha256s: [sha256('r'.repeat(40))] },
  ],
  topics: {
    'test.ordered': {
      producer: 'worker',
      subscribers: ['reader'],
      delivery: 'ordered',
      maxEventsPerSecond: 5,
    },
    'test.latest': {
      producer: 'worker',
      subscribers: ['reader'],
      delivery: 'latest-wins',
      maxEventsPerSecond: 5,
    },
  },
});

function publish(topic: string, bootId: string, seq: number): EventPublish {
  const data = Buffer.from('x');
  return {
    topic,
    producer: 'worker',
    bootId,
    seq,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: data.toString('base64'),
    bytes: data.byteLength,
  };
}

function subscribed(topic: string): { router: EventRouter; heard: EventDelivery[] } {
  const heard: EventDelivery[] = [];
  const router = new EventRouter(config, {
    deliver: (_socket, delivery, acknowledge) => {
      heard.push(delivery);
      acknowledge({ accepted: true, refusal: 'none', detail: '' });
    },
  });
  const ack = router.subscribe(
    { subscriptionId: crypto.randomUUID(), topic, subscriber: 'reader', resume: null },
    'socket-reader',
  );
  expect(ack.ok).toBe(true);
  return { router, heard };
}

const markers = (heard: readonly EventDelivery[]) =>
  heard.filter((item) => item.kind === 'gap' && item.value.reason === 'boot-change');

for (const topic of ['test.ordered', 'test.latest']) {
  test(`${topic}: a boot per event reaches the subscriber as one marker per accepted event, not per attempt`, async () => {
    const { router, heard } = subscribed(topic);
    let accepted = 0;
    const events = () => heard.filter((item) => item.kind === 'event').length;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (router.publish('worker', publish(topic, crypto.randomUUID(), 0), 'socket-worker').ok) {
        accepted += 1;
        // A boundary discards what its subscriber has not been handed, so the accepted event is
        // delivered before the next attempt; this test counts markers, not losses.
        expect(await until(() => events() === accepted)).toBe(true);
      }
      // A marker queued for a refused attempt would be delivered here rather than discarded by the
      // next boundary.
      await settle();
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(50);
    // The first boot has no predecessor to announce; every later accepted event does.
    expect(markers(heard)).toHaveLength(accepted - 1);
    router.stop();
  });
}

test('a chain of refused boots reaches the subscriber as one marker from the last announced boot', async () => {
  const topic = 'test.ordered';
  const { router, heard } = subscribed(topic);
  const first = crypto.randomUUID();
  for (let seq = 0; seq < 5; seq++)
    expect(router.publish('worker', publish(topic, first, seq), 'socket-worker').ok).toBe(true);
  expect(await until(() => heard.length === 5)).toBe(true);

  // The second's rate is used up; the topic's one boot opening of the second admits `opener`, so the
  // boots after it in the same second are refused.
  const [opener, second, third, fourth] = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  expect(router.publish('worker', publish(topic, opener, 0), 'socket-worker').ok).toBe(true);
  expect(await until(() => heard.some((item) => item.kind === 'event' && item.value.bootId === opener))).toBe(
    true,
  );
  expect(router.publish('worker', publish(topic, second, 0), 'socket-worker').ok).toBe(false);
  expect(router.publish('worker', publish(topic, third, 0), 'socket-worker').ok).toBe(false);
  expect(await until(() => router.publish('worker', publish(topic, fourth, 0), 'socket-worker').ok)).toBe(
    true,
  );
  expect(await until(() => heard.some((item) => item.kind === 'event' && item.value.bootId === fourth))).toBe(
    true,
  );

  const boundary = markers(heard);
  expect(boundary).toHaveLength(2);
  expect(boundary[1]?.value).toMatchObject({ bootId: opener, fromSeq: 0, toSeq: 0, nextBootId: fourth });
  router.stop();
});
