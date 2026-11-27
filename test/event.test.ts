import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { temporaryFile } from './temporary.ts';
import { rmSync } from 'node:fs';
import { EventRouter, type EventSink } from '../packages/runtime/src/broker/events.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { EventPublishSchema, type EventSubscribe } from '../packages/contracts/src/protocol/event.ts';
import { MAX_EVENT_BYTES } from '../packages/contracts/src/protocol/bounds.ts';
import { brokerConfig, brokerHealth, delivered, freePort, until, waitConnected } from './support.ts';

const TOKEN_P = 'u'.repeat(40);
const TOKEN_S = 'v'.repeat(40);
const TOKEN_D = 'w'.repeat(40);
const BOOT = crypto.randomUUID();

const TOKENS = { publisher: TOKEN_P, subscriber: TOKEN_S, observer: TOKEN_D };

function topicBroker(delivery: 'latest-wins' | 'ordered', overrides: Record<string, unknown> = {}) {
  return brokerConfig(TOKENS, {
    topics: {
      'generic.events': {
        producer: 'publisher',
        subscribers: ['subscriber', 'observer'],
        delivery,
        maxSubscribers: 2,
        ...overrides,
      },
    },
  });
}

function publish(seq: number, bootId = BOOT, data = `event-${seq}`) {
  const bytes = Buffer.byteLength(data);
  return EventPublishSchema.parse({
    topic: 'generic.events',
    producer: 'publisher',
    bootId,
    seq,
    observedAt: null,
    cursor: `opaque-${seq}`,
    encoding: 'base64',
    data: Buffer.from(data).toString('base64'),
    bytes,
  });
}

function subscription(
  subscriber: 'subscriber' | 'observer' = 'subscriber',
  resume: EventSubscribe['resume'] = null,
): EventSubscribe {
  return {
    subscriptionId: crypto.randomUUID(),
    topic: 'generic.events',
    subscriber,
    resume,
  };
}

/**
 * Read the first real NDJSON line, skipping the door's keep-alive blanks. Every reader on this
 * contract does exactly this — including `stitchwire` itself — so a test that did not would be
 * testing a stricter contract than the one the door publishes.
 */
async function firstLine(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('subscription response has no body');
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('subscription ended before a frame arrived');
      buffered += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line !== '') return JSON.parse(line) as Record<string, unknown>;
      }
    }
  } finally {
    await reader.cancel();
  }
}

describe('bounded event router', () => {
  test('rejects producer spoof, replayed sequence and invalid boot continuation', () => {
    const sink: EventSink = {
      deliver: (_socket, _delivery, ack) => ack({ accepted: true, refusal: 'none', detail: '' }),
    };
    const router = new EventRouter(topicBroker('ordered'), sink);
    expect(router.publish('observer', publish(0), 'observer-socket').ok).toBe(false);
    expect(router.publish('publisher', publish(0), 'publisher-socket').ok).toBe(true);
    expect(router.publish('publisher', publish(0), 'publisher-socket').detail).toContain(
      'expected sequence 1',
    );
    // This used to assert `.ok === false`: a jump forward counted as a violation. That pinned a defect
    // — because of it a single rate refusal killed the topic forever, since the publisher moved ahead
    // and never rewound. A gap is a loss, which the transport announces as a gap; the violation remains
    // only a repeat of an already accepted number, checked above.
    expect(router.publish('publisher', publish(2), 'publisher-socket').ok).toBe(true);
    expect(router.publish('publisher', publish(1, crypto.randomUUID()), 'publisher-socket').detail).toContain(
      'sequence 0',
    );
    expect(router.publish('publisher', publish(0, crypto.randomUUID()), 'publisher-socket').ok).toBe(true);
  });

  test('latest-wins coalesces a synchronous burst and emits the exact skipped range', async () => {
    const deliveries: Array<Parameters<EventSink['deliver']>[1]> = [];
    const sink: EventSink = {
      deliver: (_socket, delivery, ack) => {
        deliveries.push(delivery);
        ack({ accepted: true, refusal: 'none', detail: '' });
      },
    };
    const router = new EventRouter(topicBroker('latest-wins'), sink);
    const request = subscription();
    router.subscribe(request, 'subscriber-socket');
    router.publish('publisher', publish(0), 'publisher-socket');
    router.publish('publisher', publish(1), 'publisher-socket');
    router.publish('publisher', publish(2), 'publisher-socket');
    router.publish('publisher', publish(3), 'publisher-socket');
    await delivered(deliveries, 2);
    expect(deliveries.map((item) => item.kind)).toEqual(['gap', 'event']);
    const gap = deliveries[0];
    const event = deliveries[1];
    expect(gap?.kind === 'gap' && [gap.value.fromSeq, gap.value.toSeq]).toEqual([0, 2]);
    expect(event?.kind === 'event' && event.value.seq).toBe(3);
  });

  test('ordered overflow preserves queued order then reports dropped sequence as a gap', async () => {
    const deliveries: Array<Parameters<EventSink['deliver']>[1]> = [];
    const sink: EventSink = {
      deliver: (_socket, delivery, ack) => {
        deliveries.push(delivery);
        ack({ accepted: true, refusal: 'none', detail: '' });
      },
    };
    const router = new EventRouter(topicBroker('ordered', { queueDepth: 2 }), sink);
    router.subscribe(subscription(), 'subscriber-socket');
    router.publish('publisher', publish(0), 'publisher-socket');
    router.publish('publisher', publish(1), 'publisher-socket');
    router.publish('publisher', publish(2), 'publisher-socket');
    router.publish('publisher', publish(3), 'publisher-socket');
    await delivered(deliveries, 3);
    expect(deliveries.map((item) => item.kind)).toEqual(['event', 'event', 'gap']);
    const sequences = deliveries
      .filter((item) => item.kind === 'event')
      .map((item) => (item.kind === 'event' ? item.value.seq : -1));
    expect(sequences).toEqual([0, 1]);
    const gap = deliveries.at(-1);
    expect(gap?.kind === 'gap' && [gap.value.fromSeq, gap.value.toSeq]).toEqual([2, 3]);
  });

  test('producer boot change emits provenance gap before the new boot sequence', async () => {
    const deliveries: Array<Parameters<EventSink['deliver']>[1]> = [];
    const sink: EventSink = {
      deliver: (_socket, delivery, ack) => {
        deliveries.push(delivery);
        ack({ accepted: true, refusal: 'none', detail: '' });
      },
    };
    const router = new EventRouter(topicBroker('ordered'), sink);
    router.subscribe(subscription(), 'subscriber-socket');
    router.publish('publisher', publish(0), 'publisher-socket');
    await delivered(deliveries, 1);
    const nextBoot = crypto.randomUUID();
    router.publish('publisher', publish(0, nextBoot), 'replacement-socket');
    await delivered(deliveries, 3);
    expect(deliveries.map((item) => item.kind)).toEqual(['event', 'gap', 'event']);
    const gap = deliveries[1];
    const event = deliveries[2];
    expect(gap?.kind === 'gap' && gap.value.reason).toBe('boot-change');
    expect(event?.kind === 'event' && [event.value.bootId, event.value.seq]).toEqual([nextBoot, 0]);
  });

  test('a slow subscriber times out without delaying or deleting a fast subscriber', async () => {
    const fast: Array<Parameters<EventSink['deliver']>[1]> = [];
    const slow: Array<Parameters<EventSink['deliver']>[1]> = [];
    const sink: EventSink = {
      deliver: (socket, delivery, ack) => {
        if (socket === 'slow') {
          slow.push(delivery);
          return;
        }
        fast.push(delivery);
        ack({ accepted: true, refusal: 'none', detail: '' });
      },
    };
    const router = new EventRouter(topicBroker('ordered', { subscriberIdleMs: 1_000 }), sink);
    router.subscribe(subscription('subscriber'), 'fast');
    router.subscribe(subscription('observer'), 'slow');
    router.publish('publisher', publish(0), 'publisher-socket');
    expect(
      await until(
        () => fast.some((item) => item.kind === 'event') && slow.some((item) => item.kind === 'event'),
      ),
    ).toBe(true);
    // The slow subscriber never acknowledges; its idle bound ends it and only it.
    expect(
      await until(() => slow.some((item) => item.kind === 'error') && router.status().subscriptions === 1),
    ).toBe(true);
    expect(fast.some((item) => item.kind === 'error')).toBe(false);
  });

  test('rate, bytes, subscriber count and disconnect state are bounded', () => {
    const sink: EventSink = {
      deliver: (_socket, _delivery, ack) => ack({ accepted: true, refusal: 'none', detail: '' }),
    };
    const router = new EventRouter(
      topicBroker('ordered', { maxEventsPerSecond: 1, maxSubscribers: 1 }),
      sink,
    );
    expect(router.subscribe(subscription(), 'one').ok).toBe(true);
    expect(router.subscribe(subscription('observer'), 'two').ok).toBe(false);
    expect(router.publish('publisher', publish(0), 'publisher-socket').ok).toBe(true);
    expect(router.publish('publisher', publish(1), 'publisher-socket').failure).toBe('denied');
    expect(
      router.publish('publisher', publish(1, BOOT, 'x'.repeat(64 * 1024 + 1)), 'publisher-socket').failure,
    ).toBe('denied');
    router.disconnect('one', 'subscriber');
    expect(router.status().subscriptions).toBe(0);
    router.disconnect('publisher-socket', 'publisher');
    expect(router.status().topics).toBe(0);
    expect(() =>
      EventPublishSchema.parse({
        ...publish(0),
        data: Buffer.alloc(MAX_EVENT_BYTES + 1).toString('base64'),
        bytes: MAX_EVENT_BYTES + 1,
      }),
    ).toThrow();
  });

  test('publisher disconnect leaves subscribers alone and only marks the producer away', async () => {
    const deliveries: Array<Parameters<EventSink['deliver']>[1]> = [];
    const sink: EventSink = {
      deliver: (_socket, delivery, ack) => {
        deliveries.push(delivery);
        ack({ accepted: true, refusal: 'none', detail: '' });
      },
    };
    const router = new EventRouter(topicBroker('ordered'), sink);
    router.subscribe(subscription(), 'subscriber-socket');
    router.publish('publisher', publish(0), 'publisher-socket');
    await delivered(deliveries, 1);
    router.disconnect('publisher-socket', 'publisher');
    // This assertion used to read `subscriptions: 0` and to require an error delivery — it pinned
    // the defect itself. A producer stepping out is not a failure of anyone's subscription: the
    // subscriber stays, hears nothing while the topic is silent, and is told `boot-change` if the
    // producer comes back on a new epoch. `accepted` is a lifetime count and deliberately survives,
    // and `topics` counts producers that are live, which this one no longer is.
    expect(router.status()).toEqual({ subscriptions: 1, accepted: 1, topics: 0 });
    expect(deliveries.some((item) => item.kind === 'error')).toBe(false);
  });

  test('config rejects unknown topic participants and topic registry overflow', () => {
    expect(() =>
      brokerConfig(
        { publisher: TOKEN_P },
        {
          topics: {
            invalid: {
              producer: 'publisher',
              subscribers: ['missing'],
              delivery: 'ordered',
            },
          },
        },
      ),
    ).toThrow();
    expect(() =>
      brokerConfig(
        { publisher: TOKEN_P, subscriber: TOKEN_S },
        {
          admission: { maxTopics: 1 },
          topics: {
            one: { producer: 'publisher', subscribers: ['subscriber'], delivery: 'ordered' },
            two: { producer: 'publisher', subscribers: ['subscriber'], delivery: 'latest-wins' },
          },
        },
      ),
    ).toThrow();
  });
});

describe('Unix event producer and consumer doors', () => {
  const port = freePort();
  const publisherSocket = temporaryFile('event-publisher.sock');
  const subscriberSocket = temporaryFile('event-subscriber.sock');
  const deniedSocket = temporaryFile('event-denied.sock');
  let broker: Awaited<ReturnType<typeof startBroker>>;
  let publisher: Awaited<ReturnType<typeof startAgent>>;
  let subscriber: Awaited<ReturnType<typeof startAgent>>;
  let denied: Agent;
  const liveSubscriptions = async () => (await brokerHealth(port)).events.subscriptions;

  beforeAll(async () => {
    for (const path of [publisherSocket, subscriberSocket, deniedSocket]) rmSync(path, { force: true });
    broker = await startBroker(
      brokerConfig(TOKENS, {
        port,
        capabilities: {
          publisher: [{ operation: 'publish', targets: ['publisher'] }],
          subscriber: [{ operation: 'subscribe', targets: ['publisher'] }],
          // rpc only, so the test can prove publish/subscribe are not implied by it
          observer: [{ operation: 'peer', targets: ['publisher'] }],
        },
        commandGrants: [{ caller: 'observer', targets: ['publisher'], command: 'echo' }],
        topics: {
          'generic.events': {
            producer: 'publisher',
            subscribers: ['subscriber', 'observer'],
            delivery: 'ordered',
            maxSubscribers: 2,
          },
          'denied.events': {
            producer: 'observer',
            subscribers: ['subscriber'],
            delivery: 'latest-wins',
            maxSubscribers: 1,
          },
        },
      }),
    );
    const lane = (token: string) => ({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token }],
      allow: {},
      streams: {},
    });
    publisher = await startAgent(
      NodeConfigSchema.parse({
        ...lane(TOKEN_P),
        nodeId: 'publisher',
        events: { publish: ['generic.events'], subscribe: [] },
        agentSocket: publisherSocket,
      }),
    );
    subscriber = await startAgent(
      NodeConfigSchema.parse({
        ...lane(TOKEN_S),
        nodeId: 'subscriber',
        events: { publish: [], subscribe: ['generic.events'] },
        agentSocket: subscriberSocket,
      }),
    );
    denied = await startAgent(
      NodeConfigSchema.parse({
        ...lane(TOKEN_D),
        nodeId: 'observer',
        events: { publish: ['denied.events'], subscribe: ['generic.events'] },
        agentSocket: deniedSocket,
      }),
    );
    await waitConnected(publisher, subscriber, denied);
  });

  afterAll(async () => {
    await publisher?.stop();
    await subscriber?.stop();
    await denied?.stop();
    await broker?.stop();
    for (const path of [publisherSocket, subscriberSocket, deniedSocket]) rmSync(path, { force: true });
  });

  test('reconnect/subscription starts live and never replays a prior event or cursor', async () => {
    expect(
      (
        await publisher.publishEvent({
          topic: 'generic.events',
          bootId: BOOT,
          seq: 0,
          observedAt: null,
          cursor: 'provenance-0',
          data: 'before-subscribe',
        })
      ).ok,
    ).toBe(true);
    const subscription = subscriber.subscribeEvents({ topic: 'generic.events', resume: null });
    const next = subscription.next();
    const first = await Promise.race([next.then(() => 'event'), Bun.sleep(100).then(() => 'timeout')]);
    expect(first).toBe('timeout');
    expect(
      (
        await publisher.publishEvent({
          topic: 'generic.events',
          bootId: BOOT,
          seq: 1,
          observedAt: new Date().toISOString(),
          cursor: 'provenance-1',
          data: 'after-subscribe',
        })
      ).ok,
    ).toBe(true);
    const delivered = await next;
    expect(delivered.done).toBe(false);
    expect(!delivered.done && 'seq' in delivered.value && delivered.value.seq).toBe(1);
    await subscription.return?.();
  });

  test('Unix NDJSON subscribe and JSON publish doors carry one bounded event', async () => {
    // The previous case withdraws its subscription asynchronously; start from a broker holding none.
    expect(await until(async () => (await liveSubscriptions()) === 0)).toBe(true);
    const responsePromise = fetch('http://localhost/wire/events/subscribe', {
      unix: subscriberSocket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'generic.events' }),
    });
    // A subscription starts live, so the event is published only once the broker holds it.
    expect(await until(async () => (await liveSubscriptions()) === 1)).toBe(true);
    const published = await fetch('http://localhost/wire/events/publish', {
      unix: publisherSocket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'generic.events', bootId: BOOT, seq: 2, data: 'unix-event' }),
    });
    const ack = await published.json();
    expect(ack).toMatchObject({ ok: true, failure: 'none' });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    const event = await firstLine(response);
    expect(event.seq).toBe(2);
    expect(Buffer.from(String(event.data), 'base64').toString()).toBe('unix-event');
  });

  test('publish and subscribe capabilities are independent and retired ACL grants neither', async () => {
    const subscription = denied.subscribeEvents({ topic: 'generic.events', resume: null });
    const denial = await subscription.next();
    expect(denial.done).toBe(false);
    expect(!denial.done && 'failure' in denial.value && denial.value.failure).toBe('denied');
    await subscription.return?.();
    expect((await denied.status()).events.activeSubscriptions).toBe(0);

    const publishDenial = await denied.publishEvent({
      topic: 'denied.events',
      bootId: crypto.randomUUID(),
      seq: 0,
      observedAt: null,
      cursor: null,
      data: 'denied',
    });
    expect(publishDenial.failure).toBe('denied');
  });

  test('a door consumer that says where it stopped is answered before anything else arrives', async () => {
    for (const seq of [3, 4]) {
      const ack = await publisher.publishEvent({
        topic: 'generic.events',
        bootId: BOOT,
        seq,
        observedAt: null,
        cursor: null,
        data: `while-away-${seq}`,
      });
      expect(ack.ok).toBe(true);
    }
    const response = await fetch('http://localhost/wire/events/subscribe', {
      unix: subscriberSocket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'generic.events', resume: { bootId: BOOT, afterSeq: 2 } }),
    });
    // No further publish happens here on purpose: the answer must not depend on the topic speaking.
    expect(await firstLine(response)).toMatchObject({ fromSeq: 3, toSeq: 4, reason: 'resume' });
  });

  test('a subscription with nothing to say answers at once and keeps itself alive', async () => {
    // Bun sends no response headers until the body produces something, and resets an idle request
    // after ten seconds. A topic being quiet is its normal state, so both would turn a healthy
    // subscription into a consumer that hangs and then reconnects forever.
    const started = Date.now();
    const response = await fetch('http://localhost/wire/events/subscribe', {
      unix: subscriberSocket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: 'generic.events', resume: { bootId: BOOT, afterSeq: 99 } }),
    });
    expect(response.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('subscription response has no body');
    const chunk = await reader.read();
    expect(chunk.done).toBe(false);
    // The cursor is ahead of the broker's view, so there is nothing to report: the first bytes are
    // the keep-alive, which is exactly what proves the connection was opened rather than stalled.
    expect(new TextDecoder().decode(chunk.value).trim()).toBe('');
    await reader.cancel();
    // Closing the door's stream unsubscribes asynchronously; the slot is free once the broker says so.
    expect(await until(async () => (await liveSubscriptions()) === 0)).toBe(true);
  });
});

describe('topic flow observability', () => {
  test('health preserves declared publication obligation and marks absent policy unknown', () => {
    const sink: EventSink = {
      deliver: (_socket, _delivery, ack) => ack({ accepted: true, refusal: 'none', detail: '' }),
    };
    const modes: Array<'periodic' | 'on-change'> = ['periodic', 'on-change'];
    for (const publicationMode of modes) {
      const router = new EventRouter(topicBroker('ordered', { publicationMode }), sink);
      expect(router.topics(Date.now())[0]?.publicationMode).toBe(publicationMode);
    }
    expect(new EventRouter(topicBroker('latest-wins'), sink).topics(Date.now())[0]?.publicationMode).toBe(
      'unknown',
    );
  });

  test('a topic that has never published is distinguishable from one that fell silent', () => {
    const sink: EventSink = {
      deliver: (_socket, _delivery, ack) => ack({ accepted: true, refusal: 'none', detail: '' }),
    };
    const router = new EventRouter(topicBroker('ordered'), sink);

    const before = router.topics(Date.now());
    expect(before).toHaveLength(1);
    // Never published: there is no age to report, and reporting 0 would read as "just arrived".
    expect(before[0]?.sinceLastPublishMs).toBeNull();
    expect(before[0]?.publisherLive).toBe(false);
    expect(before[0]?.producer).toBe('publisher');
    expect(before[0]?.rejectedPublishes).toBe(0);
    expect(before[0]?.cadence).toEqual({ count: 0, windowMs: 0 });
    expect(before[0]?.sinceLastRejectionMs).toBeNull();

    expect(router.publish('publisher', publish(0), 'socket-p').ok).toBe(true);
    const after = router.topics(Date.now());
    expect(after[0]?.publisherLive).toBe(true);
    expect(after[0]?.cadence.count).toBe(1);
    expect(after[0]?.sinceLastPublishMs).not.toBeNull();
    expect(after[0]?.sinceLastPublishMs ?? -1).toBeLessThan(1_000);
  });

  test('a refused publish does not pretend the topic is still flowing', () => {
    const sink: EventSink = {
      deliver: (_socket, _delivery, ack) => ack({ accepted: true, refusal: 'none', detail: '' }),
    };
    const router = new EventRouter(topicBroker('ordered', { maxEventsPerSecond: 1 }), sink);
    expect(router.publish('publisher', publish(0), 'socket-p').ok).toBe(true);
    // One instant for both readings, not two calls to the wall clock. The property under test is
    // that the REFUSAL does not move the topic's clock; asking twice made the answer depend on
    // whether a millisecond happened to tick between them, and roughly one run in six it did.
    const observedAt = Date.now() + 5_000;
    const accepted = router.topics(observedAt)[0]?.sinceLastPublishMs ?? 0;

    // Rate-refused: the broker said no, so nothing arrived and the clock must keep running.
    const refused = router.publish('publisher', publish(1), 'socket-p');
    expect(refused.refusal).toBe('capacity');
    const afterRefusal = router.topics(observedAt)[0];
    expect(afterRefusal?.sinceLastPublishMs).toBe(accepted);
    expect(afterRefusal?.rejectedPublishes).toBe(1);
    expect(afterRefusal?.cadence.count).toBe(1);
    expect(afterRefusal?.sinceLastRejectionMs ?? -1).toBeGreaterThanOrEqual(4_000);
    expect(afterRefusal?.sinceLastRejectionMs ?? 6_000).toBeLessThanOrEqual(6_000);
  });

  test('declared ceilings are published, so a client need not discover them by being refused', () => {
    const sink: EventSink = {
      deliver: (_socket, _delivery, ack) => ack({ accepted: true, refusal: 'none', detail: '' }),
    };
    const router = new EventRouter(
      topicBroker('ordered', { maxSubscribers: 2, maxEventsPerSecond: 7, maxEventBytes: 4_096 }),
      sink,
    );
    const limits = router.topics(Date.now())[0]?.limits;
    expect(limits?.maxSubscribers).toBe(2);
    expect(limits?.maxEventsPerSecond).toBe(7);
    expect(limits?.maxEventBytes).toBe(4_096);

    router.subscribe(subscription('subscriber'), 'socket-a');
    expect(router.topics(Date.now())[0]?.subscribers).toBe(1);
  });
});

describe('subscription rate ceiling', () => {
  const sink: EventSink = {
    deliver: (_socket, _delivery, ack) => ack({ accepted: true, refusal: 'none', detail: '' }),
  };

  function rateLimitedConfig(maxEventSubscribesPerMinute: number) {
    return brokerConfig(TOKENS, {
      admission: { maxEventSubscribesPerMinute },
      topics: {
        'generic.events': {
          producer: 'publisher',
          subscribers: ['subscriber', 'observer'],
          delivery: 'ordered',
          maxSubscribers: 64,
        },
      },
    });
  }

  test('a node opening subscriptions too fast is told capacity, with when to come back', () => {
    const router = new EventRouter(rateLimitedConfig(2), sink);
    expect(router.subscribe(subscription(), 'a').ok).toBe(true);
    expect(router.subscribe(subscription(), 'b').ok).toBe(true);

    const refused = router.subscribe(subscription(), 'c');
    expect(refused.ok).toBe(false);
    // Busy, not forbidden: the caller may come back, and it is told when. `denied` would send it
    // to its config to look for a policy that is not the problem.
    expect(refused.refusal).toBe('capacity');
    expect(refused.retryAfterMs ?? 0).toBeGreaterThan(0);
    expect(refused.retryAfterMs ?? 0).toBeLessThanOrEqual(60_000);
  });

  test('the window is per node, so one loop cannot lock out the rest of the fleet', () => {
    const router = new EventRouter(rateLimitedConfig(1), sink);
    expect(router.subscribe(subscription('subscriber'), 'a').ok).toBe(true);
    expect(router.subscribe(subscription('subscriber'), 'b').ok).toBe(false);
    expect(router.subscribe(subscription('observer'), 'c').ok).toBe(true);
  });

  test('a refused attempt does not consume the budget it was refused by', () => {
    // Policy first, rate last: a node subscribing to a topic it may not read would otherwise spend
    // its own minute on attempts that never had a chance, and then be told `capacity` for what is
    // a permission problem.
    const router = new EventRouter(rateLimitedConfig(2), sink);
    const outsider = { ...subscription('subscriber'), subscriber: 'publisher' as const };
    expect(router.subscribe(outsider as never, 'a').refusal).toBe('policy');
    expect(router.subscribe(outsider as never, 'b').refusal).toBe('policy');
    expect(router.subscribe(subscription('subscriber'), 'c').ok).toBe(true);
  });

  test('lifetime admissions are counted beside live ones, which is what makes churn readable', () => {
    const router = new EventRouter(rateLimitedConfig(600), sink);
    for (let index = 0; index < 5; index += 1) {
      const request = subscription();
      router.subscribe(request, `socket-${index}`);
      router.unsubscribe('subscriber', {
        subscriptionId: request.subscriptionId,
        topic: request.topic,
        subscriber: 'subscriber',
        reason: 'done',
      });
    }
    // Five admitted, none live. Without the lifetime count that is indistinguishable from a broker
    // nobody ever subscribed to, and a consumer in a loop looks exactly like an idle fleet.
    expect(router.status()).toEqual({ subscriptions: 0, accepted: 5, topics: 0 });
  });
});

describe('a subscriber slot belongs to the node, not to the session', () => {
  const sink: EventSink = {
    deliver: (_socket, _delivery, ack) => ack({ accepted: true, refusal: 'none', detail: '' }),
  };

  test('a node reconnecting is not refused by its own previous session', () => {
    // The failure this replaces, measured live: 7461 `capacity` refusals in one journal generation.
    // A consumer restarting opens before the old session finishes closing — which is not a race
    // anyone can remove — so the node collided with itself and was told to retry into the same wall.
    const router = new EventRouter(topicBroker('ordered', { maxSubscribers: 1 }), sink);
    expect(router.subscribe(subscription('subscriber'), 'old-socket').ok).toBe(true);
    expect(router.subscribe(subscription('subscriber'), 'new-socket').ok).toBe(true);
    // Two sessions, one machine, one slot.
    expect(router.topics(Date.now())[0]?.subscribers).toBe(1);
  });

  test('a different node over the ceiling is still refused, and told who holds it', () => {
    const router = new EventRouter(topicBroker('ordered', { maxSubscribers: 1 }), sink);
    expect(router.subscribe(subscription('subscriber'), 'a').ok).toBe(true);
    const refused = router.subscribe(subscription('observer'), 'b');
    expect(refused.refusal).toBe('capacity');
    // `capacity` alone is a symptom; the holder is the repair.
    expect(refused.detail).toContain('subscriber');
    expect(refused.detail).toContain('1/1');
  });

  test('the slot is released as soon as the connection drops, not on an idle timer', () => {
    const router = new EventRouter(topicBroker('ordered', { maxSubscribers: 1 }), sink);
    expect(router.subscribe(subscription('subscriber'), 'gone').ok).toBe(true);
    router.disconnect('gone', 'subscriber');
    expect(router.topics(Date.now())[0]?.subscribers).toBe(0);
    // And the freed slot is immediately usable by a different node.
    expect(router.subscribe(subscription('observer'), 'next').ok).toBe(true);
  });

  test("closing one of a node's two sessions leaves the node holding its slot", () => {
    const router = new EventRouter(topicBroker('ordered', { maxSubscribers: 1 }), sink);
    const first = subscription('subscriber');
    expect(router.subscribe(first, 'a').ok).toBe(true);
    expect(router.subscribe(subscription('subscriber'), 'b').ok).toBe(true);
    router.unsubscribe('subscriber', {
      subscriptionId: first.subscriptionId,
      topic: first.topic,
      subscriber: 'subscriber',
      reason: 'the old consumer finally closed',
    });
    // Still one machine reading, so the ceiling still sees exactly one.
    expect(router.topics(Date.now())[0]?.subscribers).toBe(1);
    expect(router.subscribe(subscription('observer'), 'c').refusal).toBe('capacity');
  });
});
