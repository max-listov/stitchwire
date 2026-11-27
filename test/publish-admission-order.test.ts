import { expect, test } from 'bun:test';
import { LocalEventPublishSchema } from '../packages/contracts/src/door/requests.ts';
import type { EventAck, EventPublish } from '../packages/contracts/src/protocol/event.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { LocalEventBus } from '../packages/runtime/src/node/local-events.ts';
import { MultiHomePublisher } from '../packages/runtime/src/node/multi-home-publisher.ts';

/**
 * A publish the NODE refuses (pending or rate limit) reaches nobody: local subscribers are not handed
 * an event whose publisher was told it was refused. A refusal by a broker comes after local delivery
 * by design, and is told to the publisher only.
 */

const request = (seq: number) =>
  LocalEventPublishSchema.parse({
    topic: 'test.order',
    bootId: crypto.randomUUID(),
    seq,
    data: `event ${seq}`,
  });

test('an event refused for lack of publish capacity is not delivered to local subscribers', async () => {
  const config = NodeConfigSchema.parse({
    nodeId: 'publisher',
    brokers: [{ id: 'a', url: 'http://127.0.0.1:1', token: 'x'.repeat(40) }],
    admission: { maxPendingPublishes: 1 },
  });
  const local = new LocalEventBus();
  const reader = local.open('test.order', crypto.randomUUID(), 8);
  let release: (() => void) | undefined;
  const parked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lane = {
    async publishEvent(_event: EventPublish) {
      return {
        ok: true,
        failure: 'none',
        refusal: 'none',
        retryAfterMs: null,
        transportCause: null,
        detail: '',
      } as const;
    },
  };
  const publisher = new MultiHomePublisher(
    'publisher',
    {
      async selectConnected() {
        await parked;
        return { state: 'selected', lanes: [lane] };
      },
    },
    local,
    config.admission,
    { topics: ['test.order'], namespaces: [] },
  );
  try {
    const first = publisher.publish(request(0));
    expect(publisher.pending).toBe(1);
    const second = await publisher.publish(request(1));
    expect(second).toMatchObject({ ok: false, failure: 'denied', refusal: 'capacity' });
    release?.();
    expect(await first).toMatchObject({ ok: true });
    // The first event is the only one the reader hears.
    expect(await reader.next()).toMatchObject({ value: { seq: 0 } });
    // Absence is the claim, so a short wait is the only way to assert it.
    const more = await Promise.race([reader.next(), Bun.sleep(100).then(() => 'nothing' as const)]);
    expect(more).toBe('nothing');
  } finally {
    await reader.return();
  }
});

const accepted: EventAck = {
  ok: true,
  failure: 'none',
  refusal: 'none',
  retryAfterMs: null,
  transportCause: null,
  detail: '',
};

const oneLane = (publishEvent: (event: EventPublish) => Promise<EventAck>) => ({
  async selectConnected() {
    return { state: 'selected' as const, lanes: [{ publishEvent }] };
  },
});

test('an event refused for the node publish rate is not delivered to local subscribers', async () => {
  const config = NodeConfigSchema.parse({
    nodeId: 'publisher',
    brokers: [{ id: 'a', url: 'http://127.0.0.1:1', token: 'x'.repeat(40) }],
    admission: { maxPublishesPerMinute: 1 },
  });
  const local = new LocalEventBus();
  const reader = local.open('test.order', crypto.randomUUID(), 8);
  const publisher = new MultiHomePublisher(
    'publisher',
    oneLane(async () => accepted),
    local,
    config.admission,
    { topics: ['test.order'], namespaces: [] },
  );
  try {
    expect(await publisher.publish(request(0))).toMatchObject({ ok: true });
    const refused = await publisher.publish(request(1));
    expect(refused).toMatchObject({ ok: false, failure: 'denied', refusal: 'capacity' });
    expect(refused.detail).toContain('rate');
    expect(await reader.next()).toMatchObject({ value: { seq: 0 } });
    // Local delivery is synchronous inside `publish`, so a delivered event would already be queued;
    // absence is the claim, so a short wait is the only way to assert it.
    const more = await Promise.race([reader.next(), Bun.sleep(100).then(() => 'nothing' as const)]);
    expect(more).toBe('nothing');
  } finally {
    await reader.return();
  }
});

test('a broker refusal does not take back the local delivery', async () => {
  const config = NodeConfigSchema.parse({
    nodeId: 'publisher',
    brokers: [{ id: 'a', url: 'http://127.0.0.1:1', token: 'x'.repeat(40) }],
  });
  const local = new LocalEventBus();
  const reader = local.open('test.order', crypto.randomUUID(), 8);
  const publisher = new MultiHomePublisher(
    'publisher',
    oneLane(async () => ({ ...accepted, ok: false, failure: 'denied', refusal: 'capacity' })),
    local,
    config.admission,
    { topics: ['test.order'], namespaces: [] },
  );
  try {
    const ack = await publisher.publish(request(0));
    expect(ack).toMatchObject({ ok: false, refusal: 'capacity' });
    expect(await reader.next()).toMatchObject({ value: { seq: 0 } });
  } finally {
    await reader.return();
  }
});
