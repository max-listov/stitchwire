import { expect, test } from 'bun:test';
import type { EventPublish } from '../packages/contracts/src/protocol/event.ts';
import type { EventDelivery } from '../packages/runtime/src/broker/event-subscriptions.ts';
import { EventRouter } from '../packages/runtime/src/broker/events.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { settle, until } from './support.ts';

/**
 * A subscriber that resumes is measured from the boot subscribers were last told of. A boot the
 * broker took but refused the first event of is not announced to anyone, so a resume arriving in that
 * window is not told of it either; the next accepted boot reaches the resumed subscriber with the one
 * boundary every other subscriber gets. Two boundaries naming different successors of one boot would
 * end the subscription as divergent on the node.
 */

const config = BrokerConfigSchema.parse({
  nodes: [
    { id: 'worker', tokenSha256s: [sha256('w'.repeat(40))] },
    { id: 'reader', tokenSha256s: [sha256('r'.repeat(40))] },
  ],
  topics: {
    'test.resume': {
      producer: 'worker',
      subscribers: ['reader'],
      delivery: 'ordered',
      maxEventsPerSecond: 1,
    },
  },
});

function publish(bootId: string, seq: number): EventPublish {
  const data = Buffer.from('x');
  return {
    topic: 'test.resume',
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

test('a resume inside a refused boot opening hears one boundary, to the boot that is accepted', async () => {
  const heard: EventDelivery[] = [];
  const router = new EventRouter(config, {
    deliver: (_socket, delivery, acknowledge) => {
      heard.push(delivery);
      acknowledge({ accepted: true, refusal: 'none', detail: '' });
    },
  });
  const [first, announced, refused, accepted] = [
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
    crypto.randomUUID(),
  ];
  // `first` uses the second's rate and `announced` its boot opening, so `refused` is taken but refused.
  expect(router.publish('worker', publish(first, 0), 'socket-worker').ok).toBe(true);
  expect(router.publish('worker', publish(announced, 0), 'socket-worker').ok).toBe(true);
  expect(router.publish('worker', publish(refused, 0), 'socket-worker').ok).toBe(false);

  const subscribed = router.subscribe(
    {
      subscriptionId: crypto.randomUUID(),
      topic: 'test.resume',
      subscriber: 'reader',
      resume: { bootId: announced, afterSeq: 0 },
    },
    'socket-reader',
  );
  expect(subscribed.ok).toBe(true);
  // Up to date with the announced boot: nothing is owed, and nothing names the refused boot.
  await settle();
  expect(heard).toEqual([]);

  expect(await until(() => router.publish('worker', publish(accepted, 0), 'socket-worker').ok)).toBe(true);
  expect(await until(() => heard.some((item) => item.kind === 'event'))).toBe(true);
  const boundaries = heard.flatMap((item) => (item.kind === 'gap' ? [item.value] : []));
  expect(boundaries).toHaveLength(1);
  expect(boundaries[0]).toMatchObject({ reason: 'boot-change', bootId: announced, nextBootId: accepted });
  router.stop();
});
