import { expect, test } from 'bun:test';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { budgetBroker, budgetToken, budgetTopic } from './subscription-budget-fixture.ts';
import { freePort, until } from './support.ts';
import { MultiHomeEventConsumer } from '../packages/runtime/src/node/multi-home-events.ts';
import { LocalEventBus } from '../packages/runtime/src/node/local-events.ts';
import type { EventDelivery } from '../packages/runtime/src/node/event-consumer.ts';
import { EventSubscriptions } from '../packages/runtime/src/node/event-subscriptions.ts';

test('logical N+1 is refused while both broker lanes are offline', async () => {
  const agent = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'reader',
      brokers: ['a', 'b'].map((id, index) => ({
        id,
        url: `http://127.0.0.1:${index + 1}`,
        token: 'test-only'.padEnd(40, 'x'),
      })),
      events: { subscribe: ['test.budget'] },
      admission: { maxEventSubscriptions: 2 },
    }),
  );
  try {
    const first = agent.subscribeEvents({ topic: 'test.budget', resume: null });
    const second = agent.subscribeEvents({ topic: 'test.budget', resume: null });
    const excess = agent.subscribeEvents({ topic: 'test.budget', resume: null });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const refused = await Promise.race([
      excess.next(),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve('no capacity frame'), 1000);
      }),
    ]).finally(() => clearTimeout(timeout));
    expect(refused).toMatchObject({ done: false, value: { failure: 'denied', refusal: 'capacity' } });
    expect((await agent.status()).events.activeSubscriptions).toBe(2);
    for (let i = 0; i < 32; i++) {
      expect(await agent.subscribeEvents({ topic: 'test.budget', resume: null }).next()).toMatchObject({
        value: { refusal: 'capacity' },
      });
    }
    await first.return?.();
    await first.return?.();
    expect((await agent.status()).events.activeSubscriptions).toBe(1);
    await second.return?.();
    expect((await agent.status()).events.activeSubscriptions).toBe(0);
    await agent.drainLocal();
    expect(await agent.subscribeEvents({ topic: 'test.budget', resume: null }).next()).toMatchObject({
      value: { refusal: 'capacity' },
    });
  } finally {
    await agent.stop();
  }
});

test('terminal lanes release logical admission and every passive allocation', async () => {
  const config = NodeConfigSchema.parse({
    nodeId: 'reader',
    brokers: [{ id: 'terminal', url: 'http://127.0.0.1:1', token: budgetToken }],
    events: { subscribe: [budgetTopic] },
    admission: { maxEventSubscriptions: 1 },
  });
  const bus = new LocalEventBus();
  const subscriptions = new EventSubscriptions(
    config,
    [
      {
        endpoint: { id: 'terminal' },
        agent: {
          connected: false,
          terminal: true,
          subscribeEvents() {
            throw new Error('terminal lane must not allocate a subscriber');
          },
        },
      },
    ],
    bus,
  );
  const reader = subscriptions.open({ topic: budgetTopic, resume: null });
  expect(subscriptions.snapshot().activeSubscriptions).toBe(1);
  expect(await reader.next()).toMatchObject({
    value: { failure: 'transport', detail: 'broker lane is terminal' },
  });
  expect(await until(() => subscriptions.snapshot().activeSubscriptions === 0)).toBe(true);
  expect(bus.subscribers(budgetTopic)).toBe(0);
  await subscriptions.drain();
});

test('one logical budget spans two live lanes, partition and rejoin', async () => {
  const ports = [freePort(), freePort()];
  const brokers = await Promise.all(ports.map((port) => startBroker(budgetBroker(port))));
  const agent = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'reader',
      brokers: ports.map((port, i) => ({
        id: `lane-${i}`,
        url: `http://127.0.0.1:${port}`,
        token: budgetToken,
      })),
      events: { subscribe: [budgetTopic], publish: [budgetTopic] },
      admission: { maxEventSubscriptions: 2 },
    }),
  );
  try {
    expect((await agent.status()).lanes.every((lane) => lane.connected)).toBe(false);
    expect(await until(async () => (await agent.status()).lanes.every((lane) => lane.connected))).toBe(true);
    const first = agent.subscribeEvents({ topic: budgetTopic, resume: null });
    const second = agent.subscribeEvents({ topic: budgetTopic, resume: null });
    expect(
      await until(async () =>
        (await agent.status()).lanes.every((lane) => lane.eventSubscriptions.activeSubscriptions === 1),
      ),
    ).toBe(true);
    const before = await agent.status();
    expect(before.events.activeSubscriptions).toBe(2);
    expect(before.events.subscriptions).toHaveLength(2);
    expect(before.events.topics).toEqual([{ topic: budgetTopic, activeSubscriptions: 2 }]);
    expect(new Set(before.events.subscriptions.map((reader) => reader.subscriptionId)).size).toBe(2);
    expect(await agent.subscribeEvents({ topic: budgetTopic, resume: null }).next()).toMatchObject({
      value: { refusal: 'capacity' },
    });
    const [left] = brokers;
    const [port] = ports;
    if (!left || !port) throw new Error('missing test broker');
    await left.stop();
    expect(
      await until(async () => (await agent.status()).lanes.filter((lane) => lane.connected).length === 1),
    ).toBe(true);
    expect((await agent.status()).events.activeSubscriptions).toBe(2);
    expect(await agent.subscribeEvents({ topic: budgetTopic, resume: null }).next()).toMatchObject({
      value: { refusal: 'capacity' },
    });
    const ack = await agent.publishEvent({
      topic: budgetTopic,
      bootId: crypto.randomUUID(),
      seq: 0,
      observedAt: null,
      cursor: null,
      data: 'still-here',
    });
    expect(ack.ok).toBe(true);
    expect(await second.next()).toMatchObject({ value: { seq: 0 } });
    await first.return?.();
    expect((await agent.status()).events.activeSubscriptions).toBe(1);
    brokers[0] = await startBroker(budgetBroker(port));
    expect(
      await until(async () =>
        (await agent.status()).lanes.every(
          (lane) => lane.connected && lane.eventSubscriptions.activeSubscriptions === 1,
        ),
      ),
    ).toBe(true);
    const restored = await agent.status();
    expect(restored.events.activeSubscriptions).toBe(1);
    expect(restored.events.subscriptions[0]?.subscriptionId).toBe(
      before.events.subscriptions[1]?.subscriptionId,
    );
    await second.return?.();
    expect((await agent.status()).events.activeSubscriptions).toBe(0);
  } finally {
    await agent.stop();
    await Promise.all(brokers.map((broker) => broker.stop()));
  }
});

test('terminal broker refusal closes passive local queue and releases exactly once', async () => {
  const bus = new LocalEventBus();
  const id = crypto.randomUUID();
  let released = 0;
  async function* denied(): AsyncIterableIterator<EventDelivery> {
    yield {
      subscriptionId: id,
      topic: budgetTopic,
      from: 'broker',
      failure: 'denied',
      refusal: 'policy',
      retryAfterMs: null,
      transportCause: null,
      detail: 'test policy',
    };
  }
  const consumer = new MultiHomeEventConsumer(
    id,
    budgetTopic,
    [
      { id: 'local', iterator: bus.open(budgetTopic, id, 2), passive: true },
      { id: 'remote', iterator: denied() },
    ],
    2,
    () => {
      released++;
    },
  );
  expect(bus.subscribers(budgetTopic)).toBe(1);
  expect(await consumer.next()).toMatchObject({ value: { failure: 'denied', refusal: 'policy' } });
  expect(await until(() => released === 1)).toBe(true);
  expect(bus.subscribers(budgetTopic)).toBe(0);
  await Promise.all([consumer.return(), consumer.return()]);
  expect(released).toBe(1);
});
