import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { Server } from 'socket.io';
import type { EventAck } from '../packages/contracts/src/protocol/event.ts';
import { policyRefusal } from '../packages/contracts/src/protocol/failure.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { PublishAdmission } from '../packages/runtime/src/node/admission.ts';
import type { LaneAgent } from '../packages/runtime/src/node/agent-contract.ts';
import { eventTopicRefusal } from '../packages/runtime/src/node/event-policy.ts';
import type { TargetLaneSelector } from '../packages/runtime/src/node/lane-routing.ts';
import { LocalEventBus } from '../packages/runtime/src/node/local-events.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { MultiHomePublisher } from '../packages/runtime/src/node/multi-home-publisher.ts';
import type { TracePublication } from '../packages/runtime/src/node/publication-trace.ts';
import { firstAcceptedPublish } from '../packages/runtime/src/node/publish-fanout.ts';
import { laneParser } from '../packages/runtime/src/transport/lane-parser.ts';
import { listenLoopback, until } from './support.ts';

const ok: EventAck = {
  ok: true,
  failure: 'none',
  refusal: 'none',
  retryAfterMs: null,
  transportCause: null,
  detail: '',
};
const denied: EventAck = { ok: false, ...policyRefusal('fixture refusal') };
const admission = () => new PublishAdmission({ maxPendingPublishes: 1, publishAckTimeoutMs: 80 });

const exactly = (...topics: string[]) => ({ topics, namespaces: [] });

test('publish and subscribe authorize independently through one policy primitive', () => {
  expect(eventTopicRefusal(exactly('write.only'), 'write.only', 'publish')).toBeNull();
  expect(eventTopicRefusal(exactly(), 'write.only', 'subscribe')).toMatchObject({ refusal: 'policy' });
  expect(eventTopicRefusal(exactly(), 'read.only', 'publish')).toMatchObject({ refusal: 'policy' });
  expect(eventTopicRefusal(exactly('read.only'), 'read.only', 'subscribe')).toBeNull();
});

test('a namespace admits the names inside it and nothing that merely starts the same way', () => {
  const granted = { topics: [], namespaces: ['owner.node.'] };
  expect(eventTopicRefusal(granted, 'owner.node.metrics', 'publish')).toBeNull();
  // A bare string prefix would admit this; a namespace ends where a name segment ends.
  expect(eventTopicRefusal(granted, 'owner.nodes.metrics', 'publish')).toMatchObject({ refusal: 'policy' });
  // The namespace itself is not a topic inside it.
  expect(eventTopicRefusal(granted, 'owner.node.', 'publish')).toMatchObject({ refusal: 'policy' });
});

test('multi-home status counts a publish while it is still waiting for a lane', async () => {
  const selected = Promise.withResolvers<{
    state: 'selected';
    lanes: LaneAgent[];
  }>();
  const selector = {
    selectConnected: () => selected.promise,
  } as unknown as TargetLaneSelector<LaneAgent>;
  const publisher = new MultiHomePublisher(
    'publisher',
    selector,
    new LocalEventBus(),
    {
      maxPendingPublishes: 1,
      maxPublishesPerMinute: 100,
      publishAckTimeoutMs: 80,
      maxInflight: 1,
      maxCallsPerMinute: 100,
      maxEventSubscriptions: 1,
      maxStreamProducers: 1,
      maxStreamConsumers: 1,
      maxStreamBufferedBytes: 65_536,
      maxEventBufferedPerSubscription: 1,
    },
    exactly('example.feed'),
  );
  const pending = publisher.publish({
    topic: 'example.feed',
    bootId: crypto.randomUUID(),
    seq: 0,
    observedAt: null,
    cursor: null,
    data: '{}',
  });

  expect(publisher.pending).toBe(1);
  selected.resolve({ state: 'selected', lanes: [] });
  expect(await pending).toMatchObject({ ok: false, failure: 'transport' });
  expect(publisher.pending).toBe(0);
});

test('publish policy runs before the local fast path', async () => {
  const local = new LocalEventBus();
  const subscription = local.open('private.feed', crypto.randomUUID(), 4);
  const selector = {
    selectConnected: () => {
      throw new Error('denied publish must not select a physical lane');
    },
  } as unknown as TargetLaneSelector<LaneAgent>;
  const publisher = new MultiHomePublisher(
    'publisher',
    selector,
    local,
    {
      maxPendingPublishes: 1,
      maxPublishesPerMinute: 100,
      publishAckTimeoutMs: 80,
      maxInflight: 1,
      maxCallsPerMinute: 100,
      maxEventSubscriptions: 1,
      maxStreamProducers: 1,
      maxStreamConsumers: 1,
      maxStreamBufferedBytes: 65_536,
      maxEventBufferedPerSubscription: 4,
    },
    exactly(),
  );
  const ack = await publisher.publish({
    topic: 'private.feed',
    bootId: crypto.randomUUID(),
    seq: 0,
    observedAt: null,
    cursor: null,
    data: '{}',
  });
  expect(ack).toMatchObject({ ok: false, refusal: 'policy' });
  expect(await Promise.race([subscription.next(), Bun.sleep(20).then(() => 'silent' as const)])).toBe(
    'silent',
  );
  await subscription.return();
});

test('caller cancellation settles the outer publish but retains physical admission until settlement', async () => {
  const physical = Promise.withResolvers<EventAck>();
  const laneAdmission = admission();
  const lane = laneAdmission.dispatch(() => physical.promise);
  const controller = new AbortController();
  const outer = firstAcceptedPublish([lane], controller.signal);
  controller.abort();
  expect(await outer).toMatchObject({ failure: 'cancelled', transportCause: null });
  expect(laneAdmission.status().pending).toBe(1);
  physical.resolve(ok);
  await lane;
  await Promise.resolve();
  expect(laneAdmission.status().pending).toBe(0);
});

test('caller cancellation before dispatch releases the multi-home wait slot immediately', async () => {
  const selector = {
    selectConnected: (_timeoutMs: number, signal?: AbortSignal) =>
      new Promise<{ state: 'aborted' }>((resolve) =>
        signal?.addEventListener('abort', () => resolve({ state: 'aborted' }), { once: true }),
      ),
  } as unknown as TargetLaneSelector<LaneAgent>;
  const publisher = new MultiHomePublisher(
    'publisher',
    selector,
    new LocalEventBus(),
    {
      maxPendingPublishes: 1,
      maxPublishesPerMinute: 100,
      publishAckTimeoutMs: 1_000,
      maxInflight: 1,
      maxCallsPerMinute: 100,
      maxEventSubscriptions: 1,
      maxStreamProducers: 1,
      maxStreamConsumers: 1,
      maxStreamBufferedBytes: 65_536,
      maxEventBufferedPerSubscription: 4,
    },
    exactly('example.feed'),
  );
  const controller = new AbortController();
  const result = publisher.publish(
    {
      topic: 'example.feed',
      bootId: crypto.randomUUID(),
      seq: 0,
      observedAt: null,
      cursor: null,
      data: '{}',
    },
    controller.signal,
  );
  expect(publisher.pending).toBe(1);
  controller.abort();
  expect(await result).toMatchObject({ failure: 'cancelled', transportCause: null });
  expect(publisher.pending).toBe(0);
});

test('synchronous ACK cannot release a returned physical promise before it settles', async () => {
  const lane = admission();
  const physical = Promise.withResolvers<EventAck>();
  expect(
    await lane.dispatch((ack) => {
      ack(ok);
      return physical.promise;
    }),
  ).toEqual(ok);
  expect(lane.status().pending).toBe(1);
  expect(await lane.dispatch(() => true)).toMatchObject({ refusal: 'capacity' });
  lane.disconnect();
  expect(lane.status().pending).toBe(1);
  physical.resolve(ok);
  expect(await until(() => lane.status().pending === 0)).toBe(true);
});

test('real two-broker publication returns first ACK while slow lane remains bounded', async () => {
  const leftHttp = createServer(),
    rightHttp = createServer();
  const left = new Server(leftHttp, { parser: laneParser }),
    right = new Server(rightHttp, { parser: laneParser });
  const sockets = new Set<Socket>();
  for (const server of [leftHttp, rightHttp])
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  let firstAck = 0,
    leftSends = 0,
    rightSends = 0;
  left.on('connection', (socket) => {
    socket.on('nodes:list', (ack: (nodes: unknown[]) => void) => ack([]));
    socket.on('event:publish', (_event: unknown, ack: (reply: EventAck) => void) => {
      leftSends++;
      setTimeout(() => {
        firstAck = performance.now();
        ack(ok);
      }, 10);
    });
  });
  right.on('connection', (socket) => {
    socket.on('nodes:list', (ack: (nodes: unknown[]) => void) => ack([]));
    socket.on('event:publish', () => {
      rightSends++;
    });
  });
  const [leftPort, rightPort] = await Promise.all([listenLoopback(leftHttp), listenLoopback(rightHttp)]);
  const phases: Array<{ phase: string; lane?: string | null; requestId?: string }> = [];
  const trace: TracePublication = (_tuple, phase, fields) => phases.push({ phase, ...fields });
  const agent = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'publisher',
      brokers: [
        { id: 'lane-left', port: leftPort },
        { id: 'lane-right', port: rightPort },
      ].map(({ id, port }) => ({
        id,
        url: `http://127.0.0.1:${port}`,
        token: 'x'.repeat(40),
      })),
      events: { publish: ['example.feed'] },
      admission: { publishAckTimeoutMs: 200, maxPendingPublishes: 1 },
    }),
    undefined,
    undefined,
    trace,
  );
  try {
    expect(await until(async () => (await agent.status()).lanes.every((lane) => lane.connected))).toBe(true);
    expect(
      (
        await agent.publishEvent({
          topic: 'example.feed',
          bootId: crypto.randomUUID(),
          seq: 0,
          observedAt: null,
          cursor: null,
          data: '{}',
        })
      ).ok,
    ).toBe(true);
    // The publication returned on the left lane's acknowledgement: the right lane, which never
    // answers, had not yet reached its deadline or reported a result.
    expect(firstAck).toBeGreaterThan(0);
    expect(
      phases.some((p) => p.lane === 'lane-right' && (p.phase === 'timeout' || p.phase === 'lane-result')),
    ).toBe(false);
    expect([leftSends, rightSends]).toEqual([1, 1]);
    // The slow lane ends at its 200ms acknowledgement deadline; both lanes then report a result.
    const resulted = (lane: string) => phases.some((p) => p.lane === lane && p.phase === 'lane-result');
    expect(await until(() => resulted('lane-left') && resulted('lane-right'))).toBe(true);
    expect(phases.filter((p) => p.lane === 'lane-left').map((p) => p.phase)).toEqual([
      'lane-dispatch',
      'engine-handoff',
      'engine-ack-received',
      'settled',
      'lane-result',
    ]);
    // Admission and native waits have separate clocks; their terminal callbacks may race.
    expect(
      phases.filter((p) => p.lane === 'lane-right' && p.phase !== 'lane-result').map((p) => p.phase),
    ).toEqual(['lane-dispatch', 'engine-handoff', 'timeout']);
    expect(phases.filter((p) => p.lane === 'lane-right' && p.phase === 'lane-result')).toHaveLength(1);
    const native = phases.filter((p) => p.requestId !== undefined);
    expect(new Set(native.map((p) => p.requestId)).size).toBe(2);
    expect(
      (
        await agent.publishEvent({
          topic: 'example.feed',
          bootId: crypto.randomUUID(),
          seq: 0,
          observedAt: null,
          cursor: null,
          data: '{}',
        })
      ).ok,
    ).toBe(true);
    expect(rightSends).toBe(2);
  } finally {
    await agent.stop();
    for (const socket of sockets) socket.destroy();
    left.close();
    right.close();
  }
});

test('first success does not release blackholed lane admission or replay publication', async () => {
  const slow = admission();
  let sends = 0;
  const pending = slow.dispatch(() => {
    sends++;
    return true;
  });
  const reply = await firstAcceptedPublish([pending, Promise.resolve(ok)]);
  expect(reply.ok).toBe(true);
  expect(slow.status().pending).toBe(1);
  expect(
    await slow.dispatch(() => {
      sends++;
      return true;
    }),
  ).toMatchObject({ refusal: 'capacity' });
  expect(await pending).toMatchObject({ failure: 'timeout' });
  expect(slow.status().pending).toBe(0);
  expect(sends).toBe(1);
});

test('late success/failure/rejection is consumed; all refusals stay deterministic', async () => {
  for (const late of [ok, denied]) {
    const deferred = Promise.withResolvers<EventAck>();
    expect((await firstAcceptedPublish([deferred.promise, Promise.resolve(ok)])).ok).toBe(true);
    deferred.resolve(late);
    await deferred.promise;
  }
  const rejected = Promise.withResolvers<EventAck>();
  expect((await firstAcceptedPublish([Promise.resolve(ok), rejected.promise])).ok).toBe(true);
  rejected.reject(new Error('late failure'));
  // Absence: a late rejection must surface nowhere, so it gets the turn it would need to.
  await Bun.sleep(1);
  expect(await firstAcceptedPublish([Promise.resolve(denied), Promise.resolve(denied)])).toEqual(denied);
  expect(await firstAcceptedPublish([])).toMatchObject({ ok: false, failure: 'transport' });
});

test('disconnect and synchronous send failure release pending leases; late ACK has no effect', async () => {
  const lane = admission();
  let acknowledge: ((ack: EventAck) => void) | undefined;
  const pending = lane.dispatch((ack) => {
    acknowledge = ack;
    return true;
  });
  lane.disconnect();
  expect(await pending).toMatchObject({
    failure: 'transport',
    transportCause: 'lane-lost-after-dispatch',
  });
  acknowledge?.(ok);
  expect(lane.status().pending).toBe(0);
  expect(
    await lane.dispatch(() => {
      throw new Error('send failed');
    }),
  ).toMatchObject({ failure: 'transport' });
  expect(lane.status().pending).toBe(0);
});
