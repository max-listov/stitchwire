import { expect, test } from 'bun:test';
import type { EventPublish } from '../packages/contracts/src/protocol/event.ts';
import { EventDeclareSchema } from '../packages/contracts/src/protocol/topic.ts';
import type { EventDelivery } from '../packages/runtime/src/broker/event-subscriptions.ts';
import { EventTopicState } from '../packages/runtime/src/broker/event-topic-state.ts';
import { EventRouter } from '../packages/runtime/src/broker/events.ts';
import { TopicRegistry } from '../packages/runtime/src/broker/topic-registry.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { settle, until } from './support.ts';

/**
 * A topic's publish rate belongs to the topic, not to a producer boot: a producer that starts a new
 * boot for every event gets the topic rate and the one boot opening a second the topic allows above
 * it. A restarting producer's first event is admitted by that opening even when its old boot used up
 * the second, and a boot transition is always taken, so a first event refused anyway is not wedged.
 */

const config = BrokerConfigSchema.parse({
  nodes: [
    { id: 'worker', tokenSha256s: [sha256('w'.repeat(40))] },
    { id: 'reader', tokenSha256s: [sha256('r'.repeat(40))] },
  ],
  topics: {
    'test.rate': { producer: 'worker', subscribers: ['reader'], delivery: 'ordered', maxEventsPerSecond: 5 },
  },
});

function publish(bootId: string, seq: number): EventPublish {
  const data = Buffer.from('x');
  return {
    topic: 'test.rate',
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

test('a boot per event is held to the topic rate and one boot opening a second', () => {
  const state = new EventTopicState(new TopicRegistry(config));
  const accepted = { sameBoot: 0, newBoot: 0 };
  const bootId = crypto.randomUUID();
  for (let seq = 0; seq < 200; seq++)
    if (state.accept(publish(bootId, seq), 'socket-a').accepted) accepted.sameBoot += 1;

  const other = new EventTopicState(new TopicRegistry(config));
  const refusals: string[] = [];
  for (let seq = 0; seq < 200; seq++) {
    const decision = other.accept(publish(crypto.randomUUID(), 0), 'socket-a');
    if (decision.accepted) accepted.newBoot += 1;
    else refusals.push(decision.refused.refusal);
  }

  expect(accepted).toEqual({ sameBoot: 5, newBoot: 6 });
  expect(new Set(refusals)).toEqual(new Set(['capacity']));
});

test('a restart inside a used-up second is admitted, and a refused first event is not wedged', async () => {
  const state = new EventTopicState(new TopicRegistry(config));
  const first = crypto.randomUUID();
  let oldBoot = 0;
  for (let seq = 0; seq < 20; seq++) if (state.accept(publish(first, seq), 'socket-a').accepted) oldBoot += 1;
  expect(oldBoot).toBe(5);

  // The old boot has used up its second; the restarted producer's first event takes the opening.
  const second = crypto.randomUUID();
  expect(state.accept(publish(second, 0), 'socket-a')).toMatchObject({
    accepted: true,
    previousBoot: { bootId: first, nextSeq: 5 },
  });

  // A further restart in the same second finds the opening used: its first event is refused for the
  // rate, and only that event. The boot itself is taken, so the retry of sequence 0 is not refused for
  // failing to start a boot, which would wedge the stream.
  const third = crypto.randomUUID();
  const refused = state.accept(publish(third, 0), 'socket-a');
  expect(refused).toMatchObject({ accepted: false, refused: { refusal: 'capacity' } });
  expect(state.sequence('test.rate')).toMatchObject({ bootId: third, nextSeq: 0 });

  // The allowance returns within its interval; the clock is only the ceiling of this wait.
  let retry: ReturnType<typeof state.accept> | undefined;
  expect(
    await until(() => {
      retry = state.accept(publish(third, 0), 'socket-a');
      return retry.accepted;
    }),
  ).toBe(true);
  expect(retry).toMatchObject({ accepted: true, previousBoot: { bootId: second, nextSeq: 1 } });
  expect(state.accept(publish(third, 1), 'socket-a').accepted).toBe(true);
  expect(state.sequence('test.rate')).toMatchObject({ bootId: third, nextSeq: 2 });
});

test('subscribers hear a boot boundary with the new boot’s first accepted event, not with a refused one', async () => {
  const heard: EventDelivery[] = [];
  const router = new EventRouter(config, {
    deliver: (_socket, delivery, acknowledge) => {
      heard.push(delivery);
      acknowledge({ accepted: true, refusal: 'none', detail: '' });
    },
  });
  const subscribed = router.subscribe(
    { subscriptionId: crypto.randomUUID(), topic: 'test.rate', subscriber: 'reader', resume: null },
    'socket-reader',
  );
  expect(subscribed.ok).toBe(true);
  const first = crypto.randomUUID();
  for (let seq = 0; seq < 5; seq++)
    expect(router.publish('worker', publish(first, seq), 'socket-worker').ok).toBe(true);
  // A boot boundary discards what the subscriber has not been handed yet; this test is about the
  // boundary, so the old boot is delivered first.
  expect(await until(() => heard.length === 5)).toBe(true);

  // `second` takes the topic's boot opening for this second; `third` finds it used and is refused.
  const [second, third] = [crypto.randomUUID(), crypto.randomUUID()];
  expect(router.publish('worker', publish(second, 0), 'socket-worker').ok).toBe(true);
  expect(await until(() => heard.length === 7)).toBe(true);
  const refused = router.publish('worker', publish(third, 0), 'socket-worker');
  expect(refused).toMatchObject({ ok: false, refusal: 'capacity' });
  // The refusal queues nothing for the subscriber: the boundary is not announced ahead of an event.
  await settle();
  expect(heard).toHaveLength(7);

  expect(await until(() => router.publish('worker', publish(third, 0), 'socket-worker').ok)).toBe(true);
  expect(await until(() => heard.some((item) => item.kind === 'event' && item.value.bootId === third))).toBe(
    true,
  );
  const order = heard.map((item) =>
    item.kind === 'event'
      ? `event:${item.value.bootId === third ? 'third' : item.value.bootId === second ? 'second' : 'first'}:${item.value.seq}`
      : item.kind === 'gap'
        ? `gap:${item.value.reason}`
        : 'error',
  );
  expect(order).toEqual([
    'event:first:0',
    'event:first:1',
    'event:first:2',
    'event:first:3',
    'event:first:4',
    'gap:boot-change',
    'event:second:0',
    'gap:boot-change',
    'event:third:0',
  ]);
  router.stop();
});

test('a topic redeclared with a higher rate is held to the new rate from then on', () => {
  const owned = BrokerConfigSchema.parse({
    nodes: [
      { id: 'worker', tokenSha256s: [sha256('w'.repeat(40))] },
      { id: 'reader', tokenSha256s: [sha256('r'.repeat(40))] },
    ],
    topicNamespaces: { 'owner.': { producer: 'worker', subscribers: ['reader'], maxTopics: 2 } },
  });
  const registry = new TopicRegistry(owned);
  const declare = (maxEventsPerSecond: number) =>
    registry.declare(
      'worker',
      EventDeclareSchema.parse({
        producer: 'worker',
        topics: { 'owner.rate': { delivery: 'ordered', maxEventsPerSecond } },
      }),
    );
  const state = new EventTopicState(registry);
  const event = (bootId: string, seq: number): EventPublish => ({
    ...publish(bootId, seq),
    topic: 'owner.rate',
  });

  declare(5);
  const first = crypto.randomUUID();
  for (let seq = 0; seq < 5; seq++) expect(state.accept(event(first, seq), 'socket-a').accepted).toBe(true);

  declare(100);
  const second = crypto.randomUUID();
  let accepted = 0;
  for (let seq = 0; seq < 50; seq++) if (state.accept(event(second, seq), 'socket-a').accepted) accepted += 1;
  expect(accepted).toBe(50);
});
