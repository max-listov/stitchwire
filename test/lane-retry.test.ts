/**
 * A lane that keeps failing must not spin.
 *
 * Measured on the version without a backoff: **20 000 re-subscriptions in 3 ms**, and a 50 ms timer
 * scheduled alongside never fired — the retry path was synchronous down to the microtask, so it did
 * not merely burn a core, it starved the event loop entirely. On the fleet only the round trip to a
 * broker slowed it down, which is exactly why it presented for a week as a well-behaved consumer
 * polling three times a second, while a node burned 17 % of a core and wrote 400 MB of journal a day.
 *
 * So what is pinned here is not "it retries" but the three properties that were missing: it waits,
 * it yields, and a delivered frame — not an accepted subscribe — is what clears the wait.
 */

import { expect, test } from 'bun:test';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import {
  DEFAULT_LANE_RETRY,
  ResilientLaneEventIterator,
} from '../packages/runtime/src/node/lane-event-iterator.ts';
import type { EventDelivery } from '../packages/runtime/src/node/event-consumer.ts';
import { until } from './support.ts';

const FAST = { minDelayMs: 5, maxDelayMs: 40, jitter: 0.2 };

function transportFailure(): EventDelivery {
  return {
    subscriptionId: 'x',
    topic: 'generic.events',
    from: 'broker',
    failure: 'transport',
    refusal: 'none',
    retryAfterMs: null,
    transportCause: 'lane-lost-after-dispatch',
    detail: 'the lane dropped',
  };
}

function frame(seq: number, bootId: string): EventDelivery {
  return {
    subscriptionId: 'x',
    topic: 'generic.events',
    producer: 'publisher',
    bootId,
    seq,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: Buffer.from(`event-${seq}`).toString('base64'),
    bytes: 7,
  };
}

/** A lane that hands back whatever the script says, once per subscription. */
function scriptedAgent(script: () => EventDelivery | 'end'): {
  agent: Pick<Agent, 'connected' | 'subscribeEvents'> & { terminal: boolean };
  subscribes: () => number;
} {
  let subscribes = 0;
  const agent = {
    connected: true,
    terminal: false,
    subscribeEvents() {
      subscribes += 1;
      let handed = false;
      const iterator: AsyncIterableIterator<EventDelivery> = {
        next: async () => {
          if (handed) return { done: true, value: undefined };
          handed = true;
          const item = script();
          return item === 'end' ? { done: true, value: undefined } : { done: false, value: item };
        },
        return: async () => ({ done: true, value: undefined }),
        [Symbol.asyncIterator]() {
          return iterator;
        },
      };
      return iterator;
    },
  };
  return { agent, subscribes: () => subscribes };
}

test('a lane that always fails waits between attempts instead of spinning', async () => {
  const { agent, subscribes } = scriptedAgent(() => transportFailure());
  const iterator = new ResilientLaneEventIterator(
    agent,
    { topic: 'generic.events', resume: null },
    FAST,
    () => {},
  );

  // A timer scheduled alongside is the assertion that matters: on the old code it never fired,
  // which is the difference between a busy loop and a starved process.
  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 20);

  const spinning = iterator.next();
  await Bun.sleep(120);
  await iterator.return();
  await spinning;

  expect(timerFired).toBe(true);
  // With 5ms doubling to 40ms, ~120ms buys a handful of attempts. The old code managed 20 000 in 3ms.
  expect(subscribes()).toBeGreaterThan(1);
  expect(subscribes()).toBeLessThan(40);
});

test('the wait grows, so a broker that is down is not hammered at a fixed rate', async () => {
  const { agent, subscribes } = scriptedAgent(() => transportFailure());
  const iterator = new ResilientLaneEventIterator(
    agent,
    { topic: 'generic.events', resume: null },
    { minDelayMs: 4, maxDelayMs: 400, jitter: 0 },
    () => {},
  );
  const spinning = iterator.next();
  await Bun.sleep(100);
  const early = subscribes();
  await Bun.sleep(100);
  const late = subscribes();
  await iterator.return();
  await spinning;

  // The second window must produce fewer attempts than the first: that is what backing off means,
  // and a fixed delay would make the two windows equal.
  expect(late - early).toBeLessThan(early);
});

test('a delivered frame clears the wait; an accepted subscribe does not', async () => {
  const boot = crypto.randomUUID();
  let step = 0;
  const { agent, subscribes } = scriptedAgent(() => {
    step += 1;
    // Fail, fail, deliver — then fail again. If the backoff had been cleared by the successful
    // SUBSCRIBE rather than by the frame, the loop being defended against would reset its own
    // timer forever: every attempt in it was accepted by the broker.
    return step === 3 ? frame(7, boot) : transportFailure();
  });
  const iterator = new ResilientLaneEventIterator(
    agent,
    { topic: 'generic.events', resume: null },
    FAST,
    () => {},
  );

  const delivered = await iterator.next();
  expect(delivered.done).toBe(false);
  expect((delivered.value as { seq: number }).seq).toBe(7);
  expect(subscribes()).toBe(3);

  const spinning = iterator.next();
  await Bun.sleep(30);
  await iterator.return();
  await spinning;
  // Back at the minimum, and the sleep IS the instrument: 30ms is shorter than the grown delay of
  // 40ms, so an extra subscribe inside that window can only happen if the wait was reset. A wall
  // clock stood here as well — `elapsed < 200ms` — and it proved nothing, because 200ms passes
  // whether the delay is the minimum 5ms or the grown 40ms. It could only ever fail for being
  // unlucky, which is the exact opposite of what an assertion is for.
  expect(subscribes()).toBeGreaterThan(3);
});

test('every attempt names the reason, because silence is how this lived for a week', async () => {
  const lines: string[] = [];
  const { agent } = scriptedAgent(() => transportFailure());
  const iterator = new ResilientLaneEventIterator(
    agent,
    { topic: 'generic.events', resume: null },
    FAST,
    (line) => lines.push(line),
  );
  const spinning = iterator.next();
  expect(await until(() => lines.length > 0)).toBe(true);
  await iterator.return();
  await spinning;

  expect(lines[0]).toContain("subscription to 'generic.events' lost");
  expect(lines[0]).toContain('the lane dropped');
  expect(lines[0]).toMatch(/retrying in \d+ms/);
});

test('the shipped policy is bounded and jittered', () => {
  expect(DEFAULT_LANE_RETRY.minDelayMs).toBeGreaterThan(0);
  expect(DEFAULT_LANE_RETRY.maxDelayMs).toBeGreaterThanOrEqual(DEFAULT_LANE_RETRY.minDelayMs);
  // Without jitter two lanes of a multi-homed node retry in lockstep forever after failing together.
  expect(DEFAULT_LANE_RETRY.jitter).toBeGreaterThan(0);
});

test('a consumer that closed the iterator is not announced as a lost subscription', async () => {
  // Closing is the normal end of a local reader, and the lane ending is its consequence. Reporting
  // it as a loss put seven lines a second into a node's journal whose neighbour reopens in a loop,
  // and paid for each with a pause nobody was waiting on.
  const lines: string[] = [];
  let release: (() => void) | undefined;
  const agent = {
    connected: true,
    terminal: false,
    subscribeEvents() {
      const iterator: AsyncIterableIterator<EventDelivery> = {
        next: () =>
          new Promise((resolve) => {
            release = () => resolve({ done: true, value: undefined });
          }),
        return: async () => ({ done: true, value: undefined }),
        [Symbol.asyncIterator]() {
          return iterator;
        },
      };
      return iterator;
    },
  };

  const iterator = new ResilientLaneEventIterator(
    agent,
    { topic: 'generic.events', resume: null },
    FAST,
    (line) => lines.push(line),
  );
  const pending = iterator.next();
  // The lane is open once its subscription is waiting on the broker.
  expect(await until(() => release !== undefined)).toBe(true);
  await iterator.return();
  release?.(); // the lane ends because the consumer left, not because anything was lost
  expect(await pending).toEqual({ done: true, value: undefined });
  // Absence: a loss line would follow on a later turn, so the clock is the instrument here.
  await Bun.sleep(30);
  expect(lines).toEqual([]);
});
