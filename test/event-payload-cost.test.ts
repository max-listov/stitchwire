import { expect, test } from 'bun:test';
import { MAX_EVENT_BYTES } from '../packages/contracts/src/protocol/bounds.ts';
import {
  EventFrameSchema,
  EventPublishSchema,
  type EventPublish,
} from '../packages/contracts/src/protocol/event.ts';
import { LocalEventPublishSchema } from '../packages/contracts/src/door/requests.ts';
import { eventDeliverySize } from '../packages/runtime/src/event-delivery-size.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import {
  MultiHomePublisher,
  prepareEventPublish,
} from '../packages/runtime/src/node/multi-home-publisher.ts';
import { LocalEventBus } from '../packages/runtime/src/node/local-events.ts';

const request = (data: string) =>
  LocalEventPublishSchema.parse({ topic: 'test.cost', bootId: crypto.randomUUID(), seq: 0, data });

test('prepared publication is shared by both lanes, byte-exact locally and cancelled before any work', async () => {
  const received: EventPublish[] = [];
  const local = new LocalEventBus();
  const reader = local.open('test.cost', crypto.randomUUID(), 4);
  const controller = new AbortController();
  const lane = {
    async publishEvent(event: EventPublish, signal?: AbortSignal) {
      expect(signal).toBe(controller.signal);
      received.push(event);
      return {
        ok: true,
        failure: 'none',
        refusal: 'none',
        retryAfterMs: null,
        transportCause: null,
        detail: '',
      } satisfies Awaited<ReturnType<MultiHomePublisher['publish']>>;
    },
  };
  const config = NodeConfigSchema.parse({
    nodeId: 'publisher',
    brokers: [{ id: 'a', url: 'http://127.0.0.1:1', token: 'x'.repeat(40) }],
  });
  const publisher = new MultiHomePublisher(
    'publisher',
    {
      async selectConnected() {
        return { state: 'selected', lanes: [lane, lane] };
      },
    },
    local,
    config.admission,
    { topics: ['test.cost'], namespaces: [] },
  );
  try {
    const input = request('Unicode 🦎\n"\\ and body');
    expect(await publisher.publish(input, controller.signal)).toMatchObject({ ok: true });
    expect(received).toHaveLength(2);
    expect(received[0]).toBe(received[1]);
    expect(await reader.next()).toMatchObject({
      value: { ...received[0], subscriptionId: reader.subscriptionId },
    });
    const prepared = received[0];
    if (!prepared) throw new Error('missing publish');
    expect(Buffer.from(prepared.data, 'base64').toString('utf8')).toBe(input.data);
    expect(prepared.bytes).toBe(Buffer.byteLength(input.data));
    controller.abort();
    expect(await publisher.publish(input, controller.signal)).toMatchObject({ failure: 'cancelled' });
    expect(received).toHaveLength(2);
  } finally {
    await reader.return();
  }
});

test('queue accounting is exact at base64 boundaries and escaped Unicode metadata', () => {
  for (const size of [1, 2, 3, 4, 1023, MAX_EVENT_BYTES]) {
    for (const cursor of [null, '"\\\n\t\u0000🦎'.repeat(20)]) {
      const input = { ...request('x'.repeat(size)), cursor };
      const event = EventFrameSchema.parse({
        ...prepareEventPublish('publisher', input),
        subscriptionId: crypto.randomUUID(),
      });
      expect(eventDeliverySize(event)).toBe(Buffer.byteLength(JSON.stringify(event)));
      // Subscriber-specific addressing cannot reuse another frame's complete envelope size.
      expect(eventDeliverySize({ ...event, cursor: 'changed' })).toBe(
        Buffer.byteLength(JSON.stringify({ ...event, cursor: 'changed' })),
      );
      for (const kind of ['event', 'gap', 'error']) {
        const envelope = { kind, value: event };
        const counted =
          Buffer.byteLength(JSON.stringify({ kind, value: null })) - 4 + eventDeliverySize(event);
        expect(counted).toBe(Buffer.byteLength(JSON.stringify(envelope)));
      }
    }
  }
  expect(() => request('x'.repeat(MAX_EVENT_BYTES + 1))).toThrow();
  expect(() => request('🦎'.repeat(MAX_EVENT_BYTES / 4 + 1))).toThrow();
  const valid = prepareEventPublish('publisher', request('x'));
  expect(EventPublishSchema.safeParse({ ...valid, data: 'not base64' }).success).toBe(false);
  expect(EventPublishSchema.safeParse({ ...valid, bytes: 2 }).success).toBe(false);
  expect(EventPublishSchema.safeParse({ ...valid, unexpected: true }).success).toBe(false);
});
