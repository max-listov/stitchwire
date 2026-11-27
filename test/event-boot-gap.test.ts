import { expect, test } from 'bun:test';
import type {
  EventAck,
  EventDeliveryAck,
  EventPublish,
  EventSubscribe,
} from '../packages/contracts/src/protocol/event.ts';
import {
  type EventDelivery,
  EventSubscriptions,
} from '../packages/runtime/src/broker/event-subscriptions.ts';
import { EventTopicState } from '../packages/runtime/src/broker/event-topic-state.ts';
import { TopicRegistry } from '../packages/runtime/src/broker/topic-registry.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { acknowledgeEach, until } from './support.ts';

/**
 * An ordered subscriber that overflowed in one producer boot must hear the next boot's events as
 * events. The overflow it left behind belongs to the old boot and goes with it.
 */

const config = BrokerConfigSchema.parse({
  nodes: [
    { id: 'worker', tokenSha256s: [sha256('w'.repeat(40))] },
    { id: 'reader', tokenSha256s: [sha256('r'.repeat(40))] },
  ],
  topics: {
    'test.boot': {
      producer: 'worker',
      subscribers: ['reader'],
      delivery: 'ordered',
      queueDepth: 2,
      maxEventsPerSecond: 1000,
    },
  },
});

function publication(bootId: string, seq: number): EventPublish {
  const data = Buffer.from(`event ${seq}`);
  return {
    topic: 'test.boot',
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

test('events of a new producer boot reach an ordered subscriber that had overflowed in the old one', async () => {
  const held: Array<{ delivery: EventDelivery; acknowledge: (ack: EventDeliveryAck) => void }> = [];
  const subscriptions = new EventSubscriptions(config, {
    deliver: (_socket, delivery, acknowledge) => held.push({ delivery, acknowledge }),
  });
  const registry = new TopicRegistry(config);
  const topic = registry.resolve('test.boot');
  if (topic === undefined) throw new Error('topic not declared');
  const state = new EventTopicState(registry);
  const request: EventSubscribe = {
    subscriptionId: crypto.randomUUID(),
    topic: 'test.boot',
    subscriber: 'reader',
    resume: null,
  };
  const subscribed: EventAck = subscriptions.subscribe(request, 'socket-reader', topic);
  expect(subscribed.ok).toBe(true);

  const first = crypto.randomUUID();
  for (let seq = 0; seq < 8; seq++) {
    const decision = state.accept(publication(first, seq), 'socket-worker');
    if (!decision.accepted) throw new Error('publication refused');
    subscriptions.publish(publication(first, seq), decision.skipped);
  }
  // The reader acknowledges nothing, so the queue held two events and the rest became an overflow gap.
  await until(() => held.length === 1);

  const second = crypto.randomUUID();
  const decision = state.accept(publication(second, 0), 'socket-worker');
  if (!decision.accepted || decision.previousBoot === null) throw new Error('boot change not recognised');
  subscriptions.onBootChange('test.boot', 'worker', decision.previousBoot, second);
  subscriptions.publish(publication(second, 0), decision.skipped);

  await acknowledgeEach(held, 3);
  const heard = held.map(({ delivery }) =>
    delivery.kind === 'event'
      ? `event:${delivery.value.bootId === second ? 'second' : 'first'}:${delivery.value.seq}`
      : delivery.kind === 'gap'
        ? `gap:${delivery.value.reason}:${delivery.value.bootId === second ? 'second' : 'first'}`
        : 'error',
  );
  expect(heard).toEqual(['event:first:0', 'gap:boot-change:first', 'event:second:0']);
  subscriptions.stop();
});

test('the boundary of a boot names the old boot’s high-water, so the tail dropped with it is derivable', async () => {
  const held: Array<{ delivery: EventDelivery; acknowledge: (ack: EventDeliveryAck) => void }> = [];
  const subscriptions = new EventSubscriptions(config, {
    deliver: (_socket, delivery, acknowledge) => held.push({ delivery, acknowledge }),
  });
  const registry = new TopicRegistry(config);
  const topic = registry.resolve('test.boot');
  if (topic === undefined) throw new Error('topic not declared');
  const state = new EventTopicState(registry);
  expect(
    subscriptions.subscribe(
      { subscriptionId: crypto.randomUUID(), topic: 'test.boot', subscriber: 'reader', resume: null },
      'socket-reader',
      topic,
    ).ok,
  ).toBe(true);

  // Event 0 is in flight and never acknowledged; 1 and 2 wait in the queue (depth 2); 3 to 7 overflow.
  const first = crypto.randomUUID();
  for (let seq = 0; seq < 8; seq++) {
    const decision = state.accept(publication(first, seq), 'socket-worker');
    if (!decision.accepted) throw new Error('publication refused');
    subscriptions.publish(publication(first, seq), decision.skipped);
  }
  await until(() => held.length === 1);

  const second = crypto.randomUUID();
  const decision = state.accept(publication(second, 0), 'socket-worker');
  if (!decision.accepted || decision.previousBoot === null) throw new Error('boot change not recognised');
  subscriptions.onBootChange('test.boot', 'worker', decision.previousBoot, second);
  subscriptions.publish(publication(second, 0), decision.skipped);

  await acknowledgeEach(held, 3);
  // The subscriber holds sequence 0 of the old boot. The queue's 1 and 2 and the overflow's 3 to 6
  // are not replayed, and the boundary says the old boot reached 7: the contract of a boot-change
  // marker is the producer's high-water (docs/architecture/event-sequence.md), from which the
  // subscriber reads everything it did not receive. A range that ended earlier would hide the tail.
  const boundary = held.map(({ delivery }) => delivery).find((delivery) => delivery.kind === 'gap');
  expect(boundary).toMatchObject({
    kind: 'gap',
    value: { reason: 'boot-change', bootId: first, fromSeq: 7, toSeq: 7, nextBootId: second },
  });
  const oldBootEvents = held.flatMap(({ delivery }) =>
    delivery.kind === 'event' && delivery.value.bootId === first ? [delivery.value.seq] : [],
  );
  expect(oldBootEvents).toEqual([0]);
  subscriptions.stop();
});

test('subscribers of a topic its producer stops declaring are told the producer is gone and hold no slot', async () => {
  const delivered: EventDelivery[] = [];
  const subscriptions = new EventSubscriptions(config, {
    deliver: (_socket, delivery) => delivered.push(delivery),
  });
  const topic = new TopicRegistry(config).resolve('test.boot');
  if (topic === undefined) throw new Error('topic not declared');
  const request: EventSubscribe = {
    subscriptionId: crypto.randomUUID(),
    topic: 'test.boot',
    subscriber: 'reader',
    resume: null,
  };
  expect(subscriptions.subscribe(request, 'socket-reader', topic).ok).toBe(true);
  expect(subscriptions.status().subscriptions).toBe(1);

  subscriptions.withdraw(['some.other.topic']);
  expect(subscriptions.status().subscriptions).toBe(1);

  subscriptions.withdraw(['test.boot']);
  expect(subscriptions.status().subscriptions).toBe(0);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    kind: 'error',
    value: { failure: 'offline', transportCause: 'target-offline', topic: 'test.boot' },
  });
  subscriptions.stop();
});
