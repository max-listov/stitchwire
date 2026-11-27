/**
 * A rate refusal must not kill the topic.
 *
 * Caught in a running system to within 400 milliseconds, on a single telemetry topic:
 *
 *   07:13:36.126  telemetry topic  topic publish rate reached
 *   07:13:36.533  telemetry topic  expected sequence 1881, received 1882
 *
 * And from then on, forever: by the time it was examined the broker was waiting for 297, the publisher
 * had moved on to 446 and kept growing, 121 refusals in a row, and the second topic fell silent
 * entirely. Meanwhile the SAME publisher on the second broker had zero refusals, and the actual rate
 * was 1.0 publications per second against a ceiling of 10/s: the quota was brushed by one burst, once,
 * and that was enough.
 *
 * Mechanism: the broker rejects on rate and does NOT advance `nextSeq` — it accepted nothing, and that
 * is correct. The publisher advances its own: the event is lost to it, the stream is volatile. Strict
 * equality then rejects everything, and the publisher never rewinds — there is nothing to converge
 * on. The overload protection turned into a mortal wound.
 *
 * The right answer is already described by the transport contract: "promises to know what it lost,
 * never to have it". A jump forward is a loss that is announced as a gap, not a protocol violation.
 */

import { describe, expect, test } from 'bun:test';
import { EventRouter, type EventSink } from '../packages/runtime/src/broker/events.ts';
import { EventPublishSchema, type EventSubscribe } from '../packages/contracts/src/protocol/event.ts';
import { brokerConfig, until } from './support.ts';

const TOKEN_P = 'p'.repeat(40);
const TOKEN_S = 'q'.repeat(40);
const BOOT = crypto.randomUUID();

function config(delivery: 'ordered' | 'latest-wins' = 'ordered') {
  return brokerConfig(
    { publisher: TOKEN_P, subscriber: TOKEN_S },
    {
      topics: {
        'generic.events': {
          producer: 'publisher',
          subscribers: ['subscriber'],
          delivery,
          maxSubscribers: 2,
          maxEventsPerSecond: 2,
        },
      },
    },
  );
}

function publish(seq: number) {
  return EventPublishSchema.parse({
    topic: 'generic.events',
    producer: 'publisher',
    bootId: BOOT,
    seq,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: Buffer.from(`event-${seq}`).toString('base64'),
    bytes: 7,
  });
}

function subscription(): EventSubscribe {
  return {
    subscriptionId: crypto.randomUUID(),
    topic: 'generic.events',
    subscriber: 'subscriber',
    resume: null,
  };
}

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

describe('a publish refused for rate', () => {
  test('does not lock the topic out: the next sequence is admitted', async () => {
    const { sink } = collector();
    const router = new EventRouter(config(), sink);
    router.subscribe(subscription(), 'subscriber-socket');

    expect(router.publish('publisher', publish(0), 'publisher-socket').ok).toBe(true);
    expect(router.publish('publisher', publish(1), 'publisher-socket').ok).toBe(true);

    // The third one within the same second hits the ceiling. That is ordinary backpressure, not a
    // violation.
    const refused = router.publish('publisher', publish(2), 'publisher-socket');
    expect(refused.ok).toBe(false);
    expect(refused.refusal).toBe('capacity');

    // The publisher does not rewind: the event is lost to it, and it publishes the next one. Before the
    // fix this is where "expected sequence 2, received 3" began — and never stopped. The rate window is
    // one wall-clock second: here the clock is the subject, not a stand-in for a state.
    await Bun.sleep(1_100);
    const next = router.publish('publisher', publish(3), 'publisher-socket');
    expect(next.detail).not.toContain('expected sequence');
    expect(next.ok).toBe(true);

    // And the topic keeps living instead of dying on the very first burst.
    await Bun.sleep(1_100);
    expect(router.publish('publisher', publish(4), 'publisher-socket').ok).toBe(true);
  });

  test('announces the skipped range as an overflow gap instead of swallowing it', async () => {
    const { deliveries, sink } = collector();
    const router = new EventRouter(config(), sink);
    router.subscribe(subscription(), 'subscriber-socket');

    router.publish('publisher', publish(0), 'publisher-socket');
    router.publish('publisher', publish(1), 'publisher-socket');
    router.publish('publisher', publish(2), 'publisher-socket'); // rejected on rate
    await Bun.sleep(1_100);
    router.publish('publisher', publish(3), 'publisher-socket');
    const sequence = (d: (typeof deliveries)[number]) =>
      d.kind === 'event' ? (d.value as { seq: number }).seq : -1;
    expect(await until(() => deliveries.some((d) => sequence(d) === 3))).toBe(true);

    // The half without which the fix would mean "silently accept holes": the subscriber must learn
    // exactly what went missing. The transport promises to know about a loss, not to be free of one.
    const gaps = deliveries
      .filter((d) => d.kind === 'gap')
      .map((d) => d.value as { fromSeq: number; toSeq: number; reason: string });
    expect(gaps.some((g) => g.reason === 'overflow' && g.fromSeq === 2 && g.toSeq === 2)).toBe(true);

    const seqs = deliveries.filter((d) => d.kind === 'event').map((d) => (d.value as { seq: number }).seq);
    expect(seqs).toContain(3);
  });

  test('a sequence BEHIND the cursor is still refused — replay is not loss', () => {
    const { sink } = collector();
    const router = new EventRouter(config(), sink);
    expect(router.publish('publisher', publish(0), 'publisher-socket').ok).toBe(true);
    // Repeating an already accepted number is still a violation: it is not a gap but a second truth
    // about the same event. Without this check the fix above would mean "accept anything".
    const replay = router.publish('publisher', publish(0), 'publisher-socket');
    expect(replay.ok).toBe(false);
    expect(replay.detail).toContain('expected sequence 1');
  });
});
