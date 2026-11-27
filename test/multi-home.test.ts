import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrokerHandle } from '../packages/runtime/src/broker/contracts.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import type { EventDelivery } from '../packages/runtime/src/node/event-consumer.ts';
import { MultiHomeEventConsumer } from '../packages/runtime/src/node/multi-home-events.ts';
import { EventFrameSchema, EventGapSchema } from '../packages/contracts/src/protocol/event.ts';
import { brokerConfig, brokerHealth, freePort, until, waitConnected } from './support.ts';

const PORT_A = freePort();
const PORT_B = freePort();
const CALLER_A = 'caller-a-token'.padEnd(40, 'a');
const CALLER_B = 'caller-b-token'.padEnd(40, 'b');
const EXECUTOR_A = 'executor-a-token'.padEnd(40, 'a');
const EXECUTOR_B = 'executor-b-token'.padEnd(40, 'b');
const BOOT = crypto.randomUUID();

class PushSource implements AsyncIterableIterator<EventDelivery> {
  private readonly queue: EventDelivery[] = [];
  private waiter: ((result: IteratorResult<EventDelivery>) => void) | null = null;
  private closed = false;

  push(delivery: EventDelivery): void {
    const waiter = this.waiter;
    if (waiter === null) this.queue.push(delivery);
    else {
      this.waiter = null;
      waiter({ done: false, value: delivery });
    }
  }

  next(): Promise<IteratorResult<EventDelivery>> {
    const delivery = this.queue.shift();
    if (delivery !== undefined) return Promise.resolve({ done: false, value: delivery });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  return(): Promise<IteratorResult<EventDelivery>> {
    this.closed = true;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = null;
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<EventDelivery> {
    return this;
  }
}

function authorEvent(subscriptionId: string, seq: number, bootId = BOOT): EventDelivery {
  const data = `event-${seq}`;
  return EventFrameSchema.parse({
    subscriptionId,
    topic: 'generic.multi-home',
    producer: 'executor',
    bootId,
    seq,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: Buffer.from(data).toString('base64'),
    bytes: Buffer.byteLength(data),
  });
}

function laneBroker(port: number, callerToken: string, executorToken: string, eventRate = 100) {
  return brokerConfig(
    { caller: callerToken, executor: executorToken },
    {
      port,
      capabilities: {
        caller: [
          { operation: 'peer', targets: ['executor'] },
          { operation: 'stream', targets: ['executor'] },
          { operation: 'subscribe', targets: ['executor'] },
        ],
        executor: [{ operation: 'publish', targets: ['executor'] }],
      },
      commandGrants: [
        { caller: 'caller', targets: ['executor'], command: 'echo' },
        { caller: 'caller', targets: ['executor'], command: 'sleeper' },
      ],
      topics: {
        'generic.multi-home': {
          producer: 'executor',
          subscribers: ['caller'],
          delivery: 'ordered',
          maxEventsPerSecond: eventRate,
        },
      },
    },
  );
}

/** Whether both brokers hold exactly `count` subscriptions of the caller's, as each one reports it. */
async function brokersHold(count: number): Promise<boolean> {
  const health = await Promise.all([brokerHealth(PORT_A), brokerHealth(PORT_B)]);
  return health.every((answer) => answer.events.subscriptions === count);
}

async function nextEvent(iterator: ReturnType<Agent['subscribeEvents']>) {
  return await Promise.race([
    iterator.next(),
    Bun.sleep(3_000).then(() => {
      throw new Error('timed out waiting for merged event');
    }),
  ]);
}

test('merge rejects duplicates/reorder, reports an uncovered range and preserves exact boot change', async () => {
  const left = new PushSource();
  const right = new PushSource();
  const localId = crypto.randomUUID();
  const leftId = crypto.randomUUID();
  const rightId = crypto.randomUUID();
  const merged = new MultiHomeEventConsumer(
    localId,
    'generic.multi-home',
    [
      { id: 'left', iterator: left },
      { id: 'right', iterator: right },
    ],
    8,
  );
  left.push(authorEvent(leftId, 5));
  expect((await merged.next()).value).toMatchObject({ subscriptionId: localId, seq: 5 });
  right.push(authorEvent(rightId, 5));
  left.push(authorEvent(leftId, 7));
  expect((await merged.next()).value).toMatchObject({ fromSeq: 6, toSeq: 6, reason: 'overflow' });
  expect((await merged.next()).value).toMatchObject({ seq: 7 });
  right.push(authorEvent(rightId, 6));

  const nextBoot = crypto.randomUUID();
  left.push(
    EventGapSchema.parse({
      subscriptionId: leftId,
      topic: 'generic.multi-home',
      producer: 'executor',
      bootId: BOOT,
      fromSeq: 7,
      toSeq: 7,
      reason: 'boot-change',
      nextBootId: nextBoot,
    }),
  );
  left.push(authorEvent(leftId, 0, nextBoot));
  expect((await merged.next()).value).toMatchObject({ reason: 'boot-change', bootId: BOOT });
  expect((await merged.next()).value).toMatchObject({ seq: 0, bootId: nextBoot });
  right.push(authorEvent(rightId, 7));
  const duplicate = await Promise.race([merged.next(), Bun.sleep(100).then(() => null)]);
  expect(duplicate).toBeNull();
  await merged.return();
});

describe('multi-home agent', () => {
  let brokerA: BrokerHandle;
  let brokerB: BrokerHandle;
  let caller: Agent;
  let executor: Agent;

  beforeAll(async () => {
    brokerA = await startBroker(laneBroker(PORT_A, CALLER_A, EXECUTOR_A, 1));
    brokerB = await startBroker(laneBroker(PORT_B, CALLER_B, EXECUTOR_B));
    caller = createAgent(
      NodeConfigSchema.parse({
        nodeId: 'caller',
        brokers: [
          { id: 'lane-a', url: `http://127.0.0.1:${PORT_A}`, token: CALLER_A },
          { id: 'lane-b', url: `http://127.0.0.1:${PORT_B}`, token: CALLER_B },
        ],
        events: { subscribe: ['generic.multi-home'] },
      }),
    );
    executor = createAgent(
      NodeConfigSchema.parse({
        nodeId: 'executor',
        brokers: [
          { id: 'lane-a', url: `http://127.0.0.1:${PORT_A}`, token: EXECUTOR_A },
          { id: 'lane-b', url: `http://127.0.0.1:${PORT_B}`, token: EXECUTOR_B },
        ],
        allow: {
          echo: {
            bin: '/bin/echo',
            callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
            stdin: { mode: 'text', maxBytes: 1048576 },
            env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
            timeoutMs: 900_000,
            concurrency: 128,
          },
          sleeper: {
            bin: '/bin/sleep',
            callerArgs: {
              mode: 'append',
              maxCount: 1,
              maxBytes: 16,
              allowedValues: ['0.2'],
            },
            concurrency: 1,
          },
        },
        streams: {
          echo: {
            bin: '/bin/echo',
            callerArgs: { mode: 'append', maxCount: 4, maxBytes: 1_024 },
          },
        },
        events: { publish: ['generic.multi-home'] },
      }),
    );
    await waitConnected(caller, executor);
  });

  afterAll(async () => {
    await caller?.stop();
    await executor?.stop();
    await brokerA?.stop();
    await brokerB?.stop();
  });

  test('lanes are the only shape, and ambiguous ones are rejected', () => {
    const single = NodeConfigSchema.parse({
      nodeId: 'caller',
      brokers: [{ id: 'primary', url: 'https://broker.invalid', token: CALLER_A }],
    });
    expect(single.brokers).toEqual([{ id: 'primary', url: 'https://broker.invalid', token: CALLER_A }]);
    expect(() =>
      NodeConfigSchema.parse({
        nodeId: 'caller',
        brokers: [
          { id: 'same', url: 'https://one.invalid', token: CALLER_A },
          { id: 'same', url: 'https://two.invalid', token: CALLER_B },
        ],
      }),
    ).toThrow('broker lane ids must be unique');
  });

  test('holds two independently authenticated outbound lanes and merges roster health', async () => {
    // Presence reaches the caller after its lanes connect, so both are waited for, not only the lanes.
    expect(
      await until(async () => {
        const current = await caller.status();
        return (
          current.lanes.every((lane) => lane.connected) &&
          current.nodes.some((node) => node.nodeId === 'executor' && node.serves === true)
        );
      }),
    ).toBe(true);
    const status = await caller.status();
    expect(status.lanes.map((lane) => [lane.id, lane.connected])).toEqual([
      ['lane-a', true],
      ['lane-b', true],
    ]);
    expect(status.nodes.find((node) => node.nodeId === 'executor')?.serves).toBe(true);
  });

  test('fanout is exactly-once locally and partial publish success stays explicit', async () => {
    const subscription = caller.subscribeEvents({ topic: 'generic.multi-home', resume: null });
    // A subscription starts live: publish only once both brokers hold it.
    expect(await until(() => brokersHold(1))).toBe(true);
    const firstAck = await executor.publishEvent({
      topic: 'generic.multi-home',
      bootId: BOOT,
      seq: 0,
      observedAt: null,
      cursor: null,
      data: 'zero',
    });
    expect(firstAck.ok).toBe(true);
    const first = await nextEvent(subscription);
    expect(!first.done && 'seq' in first.value && first.value.seq).toBe(0);

    const partial = await executor.publishEvent({
      topic: 'generic.multi-home',
      bootId: BOOT,
      seq: 1,
      observedAt: null,
      cursor: null,
      data: 'one',
    });
    expect(partial).toMatchObject({ ok: true, failure: 'none' });
    expect(partial.detail).toContain('1 of 2');
    const second = await nextEvent(subscription);
    expect(!second.done && 'seq' in second.value && second.value.seq).toBe(1);
    await subscription.return?.();
  });

  test('RPC and stream continue on the other lane while one broker is down', async () => {
    await brokerA.stop();
    expect(
      await until(
        async () => (await caller.status()).lanes.find((lane) => lane.id === 'lane-a')?.connected === false,
      ),
    ).toBe(true);
    const result = await caller.call({ to: 'executor', argv: ['echo', 'healthy-lane'], stdin: null });
    expect(result).toMatchObject({ failure: 'none', stdout: 'healthy-lane\n' });
    const stream = caller.openStream({
      to: 'executor',
      profile: 'echo',
      args: ['stream-lane'],
      stdin: null,
      cursor: null,
    });
    const frames = [];
    for await (const frame of stream) frames.push(frame);
    expect(frames.some((frame) => 'data' in frame)).toBe(true);
    expect(frames.at(-1)).toMatchObject({ reason: 'completed' });
  });

  test('node-owned execution concurrency is shared across broker lanes', async () => {
    brokerA = await startBroker(laneBroker(PORT_A, CALLER_A, EXECUTOR_A));
    expect(
      await until(async () => {
        const [callerStatus, executorStatus] = await Promise.all([caller.status(), executor.status()]);
        return (
          callerStatus.lanes.every((lane) => lane.connected) &&
          executorStatus.lanes.every((lane) => lane.connected) &&
          callerStatus.nodes.find((node) => node.nodeId === 'executor')?.serves === true
        );
      }),
    ).toBe(true);
    // Both brokers must route to the executor, so the two calls can take different lanes.
    expect(
      await until(async () => {
        const health = await Promise.all([brokerHealth(PORT_A), brokerHealth(PORT_B)]);
        const lanes = (await caller.status()).lanes;
        return (
          lanes.every((lane) => lane.presence === 'ready') &&
          health.every((answer) => answer.nodes.some((node) => node.nodeId === 'executor' && node.serves))
        );
      }),
    ).toBe(true);
    const [left, right] = await Promise.all([
      caller.call({ to: 'executor', argv: ['sleeper', '0.2'], stdin: null }),
      caller.call({ to: 'executor', argv: ['sleeper', '0.2'], stdin: null }),
    ]);
    expect([left.failure, right.failure].sort()).toEqual(['denied', 'none']);
  });

  test('subscription survives partition and rejoin without replaying duplicate author frames', async () => {
    // The earlier subscription is withdrawn asynchronously; start from brokers holding none.
    expect(await until(() => brokersHold(0))).toBe(true);
    const subscription = caller.subscribeEvents({ topic: 'generic.multi-home', resume: null });
    expect(await until(() => brokersHold(1))).toBe(true);
    await brokerA.stop();
    expect(
      await until(
        async () => (await caller.status()).lanes.find((lane) => lane.id === 'lane-a')?.connected === false,
      ),
    ).toBe(true);
    const whilePartitioned = await executor.publishEvent({
      topic: 'generic.multi-home',
      bootId: BOOT,
      seq: 2,
      observedAt: null,
      cursor: null,
      data: 'two',
    });
    expect(whilePartitioned.ok).toBe(true);
    const second = await nextEvent(subscription);
    expect(!second.done && 'seq' in second.value && second.value.seq).toBe(2);

    brokerA = await startBroker(laneBroker(PORT_A, CALLER_A, EXECUTOR_A));
    expect(await until(async () => (await caller.status()).lanes.every((lane) => lane.connected))).toBe(true);
    // The restarted broker knows no subscription until the caller's lane asks again.
    expect(await until(() => brokersHold(1))).toBe(true);
    const afterRejoin = await executor.publishEvent({
      topic: 'generic.multi-home',
      bootId: BOOT,
      seq: 3,
      observedAt: null,
      cursor: null,
      data: 'three',
    });
    expect(afterRejoin.ok).toBe(true);
    const third = await nextEvent(subscription);
    expect(!third.done && 'seq' in third.value && third.value.seq).toBe(3);
    const nextAfterThird = subscription.next();
    const duplicate = await Promise.race([nextAfterThird, Bun.sleep(200).then(() => null)]);
    expect(duplicate).toBeNull();

    const nextBoot = crypto.randomUUID();
    const bootAck = await executor.publishEvent({
      topic: 'generic.multi-home',
      bootId: nextBoot,
      seq: 0,
      observedAt: null,
      cursor: null,
      data: 'new-boot',
    });
    expect(bootAck.ok).toBe(true);
    const marker = await nextAfterThird;
    const firstNewBoot = await nextEvent(subscription);
    expect(!marker.done && 'reason' in marker.value && marker.value.reason).toBe('boot-change');
    expect(
      !firstNewBoot.done &&
        'seq' in firstNewBoot.value && [firstNewBoot.value.bootId, firstNewBoot.value.seq],
    ).toEqual([nextBoot, 0]);
    const duplicateBoot = await Promise.race([subscription.next(), Bun.sleep(200).then(() => null)]);
    expect(duplicateBoot).toBeNull();
    await subscription.return?.();
  });
});
