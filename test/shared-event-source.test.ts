import { expect, test } from 'bun:test';
import { createBoundedChannel } from 'stitchkit/application';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { LocalEventSubscribe } from '../packages/contracts/src/door/requests.ts';
import type { EventDelivery } from '../packages/runtime/src/node/event-consumer.ts';
import { EventSubscriptions } from '../packages/runtime/src/node/event-subscriptions.ts';
import { LocalEventBus } from '../packages/runtime/src/node/local-events.ts';
import { SharedEventSource } from '../packages/runtime/src/node/shared-event-source.ts';
import { budgetToken, budgetTopic } from './subscription-budget-fixture.ts';
import { until } from './support.ts';

const boot = crypto.randomUUID();
function frame(seq: number): EventDelivery {
  return {
    subscriptionId: crypto.randomUUID(),
    topic: budgetTopic,
    producer: 'reader',
    bootId: boot,
    seq,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: 'eA==',
    bytes: 1,
  };
}
const channel = () =>
  createBoundedChannel<EventDelivery>({
    policy: 'ordered',
    maxItems: 32,
    maxBytes: 65536,
    sizeOf: () => 1024,
  });

test('fanout isolates slow readers, releases leases and never replays history to a late reader', async () => {
  const upstream = channel();
  let emptied = 0;
  let detached = 0;
  const source = new SharedEventSource(
    budgetTopic,
    2,
    () => upstream,
    () => emptied++,
  );
  const slow = source.open(false, () => detached++);
  const fast = source.open(false, () => detached++);
  try {
    for (let seq = 0; seq < 4; seq++) {
      upstream.offer(frame(seq));
      expect(await fast.next()).toMatchObject({ value: { seq } });
    }
    expect(detached).toBe(1);
    expect(emptied).toBe(0);
    expect(await slow.next()).toMatchObject({ value: { seq: 0 } });
    expect(await slow.next()).toMatchObject({ value: { seq: 1 } });
    expect(await slow.next()).toMatchObject({ value: { failure: 'denied', refusal: 'capacity' } });
    expect((await slow.next()).done).toBe(true);
    const late = source.open(false, () => detached++);
    const next = late.next();
    expect(await Promise.race([next, Bun.sleep(10).then(() => 'quiet')])).toBe('quiet');
    upstream.offer(frame(4));
    expect(await next).toMatchObject({ value: { seq: 4, subscriptionId: late.subscriptionId } });
    expect(await fast.next()).toMatchObject({ value: { seq: 4, subscriptionId: fast.subscriptionId } });
    await late.return();
    await fast.return();
    expect(detached).toBe(3);
    expect(emptied).toBe(1);
    expect(upstream.getSnapshot().state).toBe('closed');
  } finally {
    await slow.return();
    await fast.return();
    upstream.close({ mode: 'discard' });
  }
});

test('only live readers share upstreams; topic, historical resume and policy remain isolated', async () => {
  const opened: LocalEventSubscribe[] = [];
  const channels: ReturnType<typeof channel>[] = [];
  const config = NodeConfigSchema.parse({
    nodeId: 'reader',
    brokers: [{ id: 'a', url: 'http://127.0.0.1:1', token: budgetToken }],
    events: { subscribe: [budgetTopic, 'test.other'] },
    admission: { maxEventSubscriptions: 8 },
  });
  const bus = new LocalEventBus();
  const subscriptions = new EventSubscriptions(
    config,
    ['a', 'b'].map((id) => ({
      endpoint: { id },
      agent: {
        connected: true,
        terminal: false,
        subscribeEvents(request: LocalEventSubscribe) {
          opened.push(request);
          const source = channel();
          channels.push(source);
          return source;
        },
      },
    })),
    bus,
  );
  try {
    const one = subscriptions.open({ topic: budgetTopic, resume: null });
    const two = subscriptions.open({ topic: budgetTopic, resume: null });
    expect(await until(() => opened.length === 2)).toBe(true);
    expect(bus.subscribers(budgetTopic)).toBe(1);
    expect(subscriptions.snapshot().activeSubscriptions).toBe(2);
    subscriptions.open({ topic: 'test.other', resume: null });
    subscriptions.open({ topic: budgetTopic, resume: { bootId: boot, afterSeq: 3 } });
    subscriptions.open({ topic: budgetTopic, resume: { bootId: boot, afterSeq: 3 } });
    expect(await until(() => opened.length === 8)).toBe(true);
    expect(opened.filter((request) => request.resume?.afterSeq === 3)).toHaveLength(4);
    expect(await subscriptions.open({ topic: 'test.denied', resume: null }).next()).toMatchObject({
      value: { refusal: 'policy' },
    });
    expect(opened).toHaveLength(8);
    await one.return?.();
    expect(channels.slice(0, 2).every((source) => source.getSnapshot().state === 'open')).toBe(true);
    await two.return?.();
    expect(channels.slice(0, 2).every((source) => source.getSnapshot().state === 'closed')).toBe(true);
    const fresh = subscriptions.open({ topic: budgetTopic, resume: null });
    expect(await until(() => opened.length === 10)).toBe(true);
    expect(fresh).not.toBe(one);
  } finally {
    await subscriptions.drain();
    expect(subscriptions.snapshot().activeSubscriptions).toBe(0);
    expect(bus.subscribers(budgetTopic)).toBe(0);
    expect(channels.every((source) => source.getSnapshot().state === 'closed')).toBe(true);
  }
});

test('source failure reaches all readers and frees every lease', async () => {
  const upstream = channel();
  let detached = 0;
  let emptied = 0;
  const source = new SharedEventSource(
    budgetTopic,
    2,
    () => upstream,
    () => emptied++,
  );
  const readers = [source.open(false, () => detached++), source.open(false, () => detached++)];
  upstream.offer({
    subscriptionId: null,
    topic: budgetTopic,
    from: 'broker',
    failure: 'denied',
    refusal: 'policy',
    retryAfterMs: null,
    transportCause: null,
    detail: 'denied',
  });
  for (const reader of readers) {
    expect(await reader.next()).toMatchObject({ value: { refusal: 'policy' } });
    expect((await reader.next()).done).toBe(true);
    await reader.return();
  }
  expect(detached).toBe(2);
  expect(emptied).toBe(1);
});

test('drain waits for a retiring upstream after its terminal readers released admission', async () => {
  const upstream = channel();
  const close = Promise.withResolvers<void>();
  const config = NodeConfigSchema.parse({
    nodeId: 'reader',
    brokers: [{ id: 'a', url: 'http://127.0.0.1:1', token: budgetToken }],
    events: { subscribe: [budgetTopic] },
    admission: { maxEventSubscriptions: 1 },
  });
  const bus = new LocalEventBus();
  let opened = false;
  const subscriptions = new EventSubscriptions(
    config,
    [
      {
        endpoint: { id: 'a' },
        agent: {
          connected: true,
          terminal: false,
          subscribeEvents() {
            opened = true;
            const iterator: AsyncIterableIterator<EventDelivery> = {
              next: () => upstream.next(),
              async return() {
                upstream.close({ mode: 'discard' });
                await close.promise;
                return { done: true, value: undefined };
              },
              [Symbol.asyncIterator]() {
                return iterator;
              },
            };
            return iterator;
          },
        },
      },
    ],
    bus,
  );
  try {
    const reader = subscriptions.open({ topic: budgetTopic, resume: null });
    expect(await until(() => opened)).toBe(true);
    upstream.offer({
      subscriptionId: null,
      topic: budgetTopic,
      from: 'broker',
      failure: 'denied',
      refusal: 'policy',
      retryAfterMs: null,
      transportCause: null,
      detail: 'denied',
    });
    expect(await reader.next()).toMatchObject({ value: { refusal: 'policy' } });
    expect(subscriptions.snapshot().activeSubscriptions).toBe(0);
    let drained = false;
    const pending = subscriptions.drain().then(() => {
      drained = true;
    });
    await Bun.sleep(10);
    expect(drained).toBe(false);
    close.resolve();
    await pending;
    expect(drained).toBe(true);
    expect(bus.subscribers(budgetTopic)).toBe(0);
  } finally {
    close.resolve();
    await subscriptions.drain();
  }
});
