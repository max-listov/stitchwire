/**
 * An absent producer is not a refusal of the subscription transport.
 *
 * The broker evicted subscribers every time the publishing node disconnected, including topics that had
 * NEVER published anything: those have no entry in `sequences`, and the condition caught exactly them.
 * The subscriber got a transport error and did precisely what it should — resubscribed. About ~220 ms
 * later it all repeated. The log of a live node holds 472 such lines, every one of them `attempt 1`:
 * the backoff did not grow, because the loop ran above the class that damps it. The cost was ~240
 * resubscriptions an hour per broker and a growing audit journal; before 0.21.0 every turn also took a
 * local subscription slot.
 *
 * This added not a gram of truth: a live subscriber is already told about the new epoch by
 * `boot-change`, and a returning one by `seedResume`. Eviction delivered the same information while
 * destroying the subscription.
 */

import { describe, expect, test } from 'bun:test';
import { EventPublishSchema, type EventSubscribe } from '../packages/contracts/src/protocol/event.ts';
import { EventRouter, type EventSink } from '../packages/runtime/src/broker/events.ts';
import { brokerConfig, delivered, until } from './support.ts';

const TOKEN_P = 'p'.repeat(40);
const TOKEN_S = 'q'.repeat(40);
const BOOT = crypto.randomUUID();

type SubscriptionInternals = {
  recordAdmission(now: number): void;
  admissionsByMinute: Map<number, number>;
};

function subscriptionInternals(router: EventRouter): SubscriptionInternals {
  return (router as unknown as { subscriptions: SubscriptionInternals }).subscriptions;
}

function config() {
  return brokerConfig(
    { publisher: TOKEN_P, subscriber: TOKEN_S },
    {
      topics: {
        'generic.events': {
          producer: 'publisher',
          subscribers: ['subscriber'],
          delivery: 'ordered',
          maxSubscribers: 2,
        },
        // Declared and never published anything — exactly the shape the loop lived on.
        'never.published': {
          producer: 'publisher',
          subscribers: ['subscriber'],
          delivery: 'ordered',
          maxSubscribers: 2,
        },
      },
    },
  );
}

function publish(seq: number, bootId = BOOT, topic = 'generic.events') {
  const data = Buffer.from(`event-${seq}`);
  return EventPublishSchema.parse({
    topic,
    producer: 'publisher',
    bootId,
    seq,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: data.toString('base64'),
    bytes: data.byteLength,
  });
}

function subscription(topic = 'generic.events'): EventSubscribe {
  return { subscriptionId: crypto.randomUUID(), topic, subscriber: 'subscriber', resume: null };
}

const seqOf = (items: ReadonlyArray<{ value: unknown }>): number[] =>
  items.flatMap((d) => ('seq' in (d.value as object) ? [(d.value as { seq: number }).seq] : []));

function collector() {
  const deliveries: Array<Parameters<EventSink['deliver']>[1]> = [];
  const sink: EventSink = {
    deliver: (_socket, delivery, ack) => {
      deliveries.push(delivery);
      ack({ accepted: true, refusal: 'none', detail: '' });
    },
  };
  return { deliveries, sink };
}

const failures = (deliveries: Array<Parameters<EventSink['deliver']>[1]>) =>
  deliveries.filter((d) => 'failure' in d.value);

describe('an absent producer', () => {
  test('does not evict the subscribers of a topic that never published', async () => {
    const { deliveries, sink } = collector();
    const router = new EventRouter(config(), sink);
    router.subscribe(subscription('never.published'), 'subscriber-socket');
    // Absence: an eviction would arrive on a later timer turn, so the clock is the instrument here.
    await Bun.sleep(10);

    router.disconnect('publisher-socket', 'publisher');
    await Bun.sleep(10);

    // Nothing was lost: the topic never published a single event, so there is nothing to lose.
    expect(failures(deliveries)).toEqual([]);
    expect(router.status().subscriptions).toBe(1);
  });

  test('does not end a live subscription, and the returning producer explains itself', async () => {
    const { deliveries, sink } = collector();
    const router = new EventRouter(config(), sink);
    router.subscribe(subscription(), 'subscriber-socket');
    expect(router.publish('publisher', publish(0), 'publisher-socket').ok).toBe(true);
    await delivered(deliveries, 1);

    router.disconnect('publisher-socket', 'publisher');
    // Absence: an eviction would arrive on a later timer turn, so the clock is the instrument here.
    await Bun.sleep(10);
    expect(failures(deliveries)).toEqual([]);
    expect(router.status().subscriptions).toBe(1);

    // The publisher came back in a different epoch and had already reached 41 on the local lane. The
    // broker did not see its start and cannot demand an invented zero; it is `boot-change` that tells
    // the subscriber the truth.
    const restarted = crypto.randomUUID();
    expect(router.publish('publisher', publish(41, restarted), 'publisher-socket-2').ok).toBe(true);
    expect(router.publish('publisher', publish(42, restarted), 'publisher-socket-2').ok).toBe(true);
    expect(await until(() => deliveries.some((d) => 'reason' in d.value))).toBe(true);

    const gaps = deliveries.filter((d) => 'reason' in d.value);
    expect(gaps.map((g) => (g.value as { reason: string }).reason)).toContain('boot-change');
    expect(failures(deliveries)).toEqual([]);
  });

  test('a live producer cannot be replaced mid-epoch by a nonzero sequence', async () => {
    const { deliveries, sink } = collector();
    const router = new EventRouter(config(), sink);
    router.subscribe(subscription(), 'subscriber-socket');
    expect(router.publish('publisher', publish(0), 'publisher-socket').ok).toBe(true);

    const competingBoot = crypto.randomUUID();
    const refused = router.publish('publisher', publish(7, competingBoot), 'competing-socket');
    expect(refused.ok).toBe(false);
    expect(refused.failure).toBe('rejected');
    expect(router.publish('publisher', publish(1), 'publisher-socket').ok).toBe(true);
    expect(await until(() => seqOf(deliveries).length >= 2)).toBe(true);

    // Exactly these two: the competing publish was refused synchronously above, so a third here
    // would be an admission this test exists to forbid.
    expect(seqOf(deliveries)).toEqual([0, 1]);
  });

  test('a producer that returns on the SAME epoch keeps its sequence', async () => {
    const { deliveries, sink } = collector();
    const router = new EventRouter(config(), sink);
    router.subscribe(subscription(), 'subscriber-socket');
    expect(router.publish('publisher', publish(0), 'publisher-socket').ok).toBe(true);
    router.disconnect('publisher-socket', 'publisher');

    // The network blinked, the process did not restart: same epoch, counting continues from one.
    // Previously the epoch record was erased together with the subscribers, and a returning publisher
    // with seq=1 started a new base — that is, a break in continuity that nobody was told about.
    const back = router.publish('publisher', publish(1), 'publisher-socket-2');
    expect(back.ok).toBe(true);
    expect(await until(() => seqOf(deliveries).length >= 2)).toBe(true);

    expect(seqOf(deliveries)).toEqual([0, 1]);
    expect(failures(deliveries)).toEqual([]);
  });

  test('a topic whose producer is away reports it as away', async () => {
    const { sink } = collector();
    const router = new EventRouter(config(), sink);
    expect(router.publish('publisher', publish(0), 'publisher-socket').ok).toBe(true);
    expect(router.topics(Date.now()).find((t) => t.topic === 'generic.events')?.publisherLive).toBe(true);

    router.disconnect('publisher-socket', 'publisher');
    // The subscriptions are alive but the publisher is gone — and the report must say exactly that, not
    // both at once.
    expect(router.topics(Date.now()).find((t) => t.topic === 'generic.events')?.publisherLive).toBe(false);
  });
});

describe('admission rate', () => {
  test('a recent window answers "is churn happening now", which a lifetime counter cannot', () => {
    const { sink } = collector();
    const router = new EventRouter(config(), sink);

    // Three admitted subscriptions "ten minutes ago" and two "now". A lifetime counter would show
    // five and say nothing about four of the ten minutes having been empty.
    const now = 1_800_000_000_000;
    const tenMinutesAgo = now - 10 * 60_000;
    const internals = subscriptionInternals(router);
    for (let i = 0; i < 3; i += 1) internals.recordAdmission(tenMinutesAgo);
    for (let i = 0; i < 2; i += 1) internals.recordAdmission(now);

    const recent = router.admissions(5, now);
    expect(recent.count).toBe(2);
    // `now` is exactly on a minute boundary, so the current minute has elapsed by zero and a window of
    // five buckets covers exactly four minutes. That is why windowMs is returned rather than computed
    // by the reader: dividing by a round five minutes would overstate the coverage by a quarter — at
    // exactly the moment this number exists for, the start of a burst.
    expect(recent.windowMs).toBe(4 * 60_000);

    // Thirty seconds later in the same minute the window really is wider, and this number says so.
    expect(router.admissions(5, now + 30_000).windowMs).toBe(4 * 60_000 + 30_000);

    // The hour window sees both batches — literally a different answer to a different question.
    expect(router.admissions(60, now).count).toBe(5);
  });

  test('buckets older than an hour are dropped, so the ring is bounded by construction', () => {
    const { sink } = collector();
    const router = new EventRouter(config(), sink);
    const now = 1_800_000_000_000;
    const internals = subscriptionInternals(router);

    for (let minute = 0; minute < 500; minute += 1) internals.recordAdmission(now + minute * 60_000);
    const end = now + 499 * 60_000;

    // Five hundred minutes of admissions, but only the last hour is kept: the limit here is by design,
    // not by a ceiling that would start lying exactly where the turnover count matters most.
    expect(internals.admissionsByMinute.size).toBeLessThanOrEqual(60);
    expect(router.admissions(60, end).count).toBe(60);
    expect(router.admissions(5, end).count).toBe(5);
  });
});
