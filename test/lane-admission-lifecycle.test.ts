import { expect, test } from 'bun:test';
import { createBoundedAdmission } from 'stitchkit/application';
import type { EventAck } from '../packages/contracts/src/protocol/event.ts';
import { EventConsumer } from '../packages/runtime/src/node/event-consumer.ts';
import { openLaneEventSubscription } from '../packages/runtime/src/node/lane-event-subscription.ts';
import { MultiHomeEventConsumer } from '../packages/runtime/src/node/multi-home-events.ts';

test('cancel during broker admission ignores late ACK and releases the lane slot', async () => {
  const consumers = new Map<string, EventConsumer>();
  const slots = createBoundedAdmission({ policy: { global: { maxConcurrent: 1 } } });
  let acknowledge: ((ack: EventAck) => void) | undefined;
  const consumer = openLaneEventSubscription(
    { nodeId: 'reader', allowance: { topics: ['test.quiet'], namespaces: [] }, maxBuffered: 2 },
    consumers,
    slots,
    {
      subscribe(_request, callback) {
        acknowledge = callback;
        return true;
      },
      unsubscribe(_request, callback) {
        callback();
        return true;
      },
    },
    { topic: 'test.quiet', resume: null, lifecycle: true },
  );
  const pending = consumer.next();
  expect(consumers.size).toBe(1);
  await consumer.return();
  expect(await pending).toMatchObject({ done: true });
  if (!acknowledge) throw new Error('admission was not requested');
  acknowledge({
    ok: true,
    failure: 'none',
    refusal: 'none',
    retryAfterMs: null,
    transportCause: null,
    detail: '',
  });
  expect(await consumer.next()).toMatchObject({ done: true });
  expect(consumers.size).toBe(0);
  const admitted = slots.acquire();
  expect(admitted.outcome).toBe('leased');
  if (admitted.outcome !== 'refused') admitted.lease.release();
});

test('one acknowledged lane survives a neighbor ending; last lane loss is not ready', async () => {
  const topic = 'test.quiet';
  const sources = ['left', 'right'].map((id) => ({
    id,
    iterator: new EventConsumer(
      crypto.randomUUID(),
      topic,
      'reader',
      2,
      { unsubscribe: async () => {} },
      () => {},
    ),
  }));
  const merged = new MultiHomeEventConsumer(crypto.randomUUID(), topic, sources, 4, () => {}, true);
  expect(await merged.next()).toMatchObject({ value: { subscriptionState: 'opening', lanes: [] } });
  for (const source of sources) {
    source.iterator.push({
      subscriptionId: source.iterator.subscriptionId,
      topic,
      subscriptionState: 'ready',
      lanes: ['broker'],
    });
    expect(await merged.next()).toMatchObject({ value: { subscriptionState: 'ready' } });
  }
  const [left, right] = sources;
  if (!left || !right) throw new Error('missing test lane');
  await left.iterator.return();
  expect(await merged.next()).toMatchObject({ value: { subscriptionState: 'ready', lanes: ['right'] } });
  await right.iterator.return();
  expect(await merged.next()).toMatchObject({ value: { subscriptionState: 'opening', lanes: [] } });
  expect(await merged.next()).toMatchObject({ value: { failure: 'transport' } });
  await merged.return();
});

test('a broker acknowledgement that never arrives ends the subscription and withdraws it from the broker', async () => {
  const consumers = new Map<string, EventConsumer>();
  const slots = createBoundedAdmission({ policy: { global: { maxConcurrent: 1 } } });
  const withdrawn: Array<{ subscriptionId: string; topic: string }> = [];
  const consumer = openLaneEventSubscription(
    {
      nodeId: 'reader',
      allowance: { topics: ['test.quiet'], namespaces: [] },
      maxBuffered: 2,
      ackTimeoutMs: 30,
    },
    consumers,
    slots,
    {
      subscribe: () => true,
      unsubscribe(request) {
        withdrawn.push({ subscriptionId: request.subscriptionId, topic: request.topic });
        return true;
      },
    },
    { topic: 'test.quiet', resume: null, lifecycle: false },
  );
  expect(await consumer.next()).toMatchObject({
    done: false,
    value: { failure: 'timeout', transportCause: 'acknowledgement-timeout' },
  });
  expect(withdrawn).toHaveLength(1);
  expect(withdrawn[0]?.topic).toBe('test.quiet');
  expect(consumers.size).toBe(0);
  expect(slots.acquire().outcome).toBe('leased');
});
