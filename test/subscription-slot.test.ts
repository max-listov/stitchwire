/**
 * A local subscription slot must be returned, and must have an end.
 *
 * The refusal this started with, verbatim: `refusal=capacity,
 * detail='node local event subscription limit reached'` — on all four nodes, 1251 times, with
 * a topic ceiling of 6 subscribers that nobody came close to. Measured on a live node: 32 slots
 * (exactly the limit) with eight real consumers; after a restart the same household settled at
 * eight. Twenty-four slots belonged to subscriptions that no longer existed.
 *
 * Silence is the normal state of a topic, so every test here cuts the consumer off precisely on a
 * quiet topic: the path where the defect lives.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { EventConsumer } from '../packages/runtime/src/node/event-consumer.ts';
import type { AgentHandle } from '../packages/runtime/src/node/agent-contract.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { brokerConfig, freePort, until, waitConnected } from './support.ts';

const PORT = freePort();
const TOKEN = 's'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'stitchwire-slot-'));
const socket = join(root, 'agent.sock');

let broker: Awaited<ReturnType<typeof startBroker>>;
let agent: AgentHandle;

async function activeSubscriptions(): Promise<number> {
  const response = await fetch('http://localhost/wire/status', { unix: socket });
  const status = (await response.json()) as { events: { activeSubscriptions: number } };
  return status.events.activeSubscriptions;
}

beforeAll(async () => {
  broker = await startBroker(
    brokerConfig(
      { worker: TOKEN },
      {
        port: PORT,
        capabilities: {
          worker: [
            { operation: 'publish', targets: ['worker'] },
            { operation: 'subscribe', targets: ['worker'] },
          ],
        },
        topics: {
          'quiet.events': {
            producer: 'worker',
            subscribers: ['worker'],
            delivery: 'ordered',
            maxSubscribers: 6,
          },
        },
      },
    ),
  );
  agent = await startAgent(
    NodeConfigSchema.parse({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token: TOKEN }],
      nodeId: 'worker',
      events: { publish: ['quiet.events'], subscribe: ['quiet.events'] },
      agentSocket: socket,
    }),
  );
  await waitConnected(agent);
});

afterAll(async () => {
  await agent?.stop();
  await broker?.stop();
});

test('a terminal frame ends the subscription even when the consumer queue is full', () => {
  // Mechanism B in its pure form, without a network. The capacity check stood BEFORE the branch that
  // sets terminal and calls onDone, so for a consumer with a full queue the terminal frame did not get
  // through — and the subscription never ended.
  let released = false;
  const consumer = new EventConsumer(
    'sub-1',
    'quiet.events',
    'worker',
    2,
    { unsubscribe: async () => {} },
    () => {
      released = true;
    },
  );

  // Fill the queue, there is no reader.
  for (let seq = 0; seq < 2; seq += 1) {
    const ack = consumer.push({
      subscriptionId: 'sub-1',
      topic: 'quiet.events',
      producer: 'worker',
      bootId: crypto.randomUUID(),
      seq,
      observedAt: null,
      cursor: null,
      encoding: 'base64',
      data: '',
      bytes: 0,
    } as never);
    expect(ack.accepted).toBe(true);
  }

  // An ordinary frame on top must be rejected on capacity — that is correct behaviour, and it stays.
  const overflow = consumer.push({
    subscriptionId: 'sub-1',
    topic: 'quiet.events',
    producer: 'worker',
    bootId: crypto.randomUUID(),
    seq: 2,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: '',
    bytes: 0,
  } as never);
  expect(overflow.accepted).toBe(false);
  expect(overflow.refusal).toBe('capacity');
  expect(released).toBe(false);

  // And a terminal frame is not data. It is the end of the subscription, and queue capacity cannot
  // cancel it: it is exactly how the broker's `subscriberIdleMs` conveys to the node that there is
  // nothing left to hold.
  consumer.push({
    subscriptionId: 'sub-1',
    topic: 'quiet.events',
    from: 'broker',
    failure: 'transport',
    refusal: 'none',
    retryAfterMs: null,
    transportCause: 'acknowledgement-timeout',
    detail: 'subscriber idle timeout',
  });
  expect(released).toBe(true);
});

test('a door consumer that drops on a quiet topic gives its slot back', async () => {
  const before = await activeSubscriptions();

  const departed = new AbortController();
  const opened = fetch('http://localhost/wire/events/subscribe', {
    unix: socket,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'quiet.events' }),
    signal: departed.signal,
  });
  // Headers go out on open, so the response can be awaited without waiting for a single event.
  const response = await opened;
  expect(response.status).toBe(200);
  expect(await until(async () => (await activeSubscriptions()) === before + 1)).toBe(true);

  // Not a single event was published on this topic: the consumer leaves exactly in the silence, where
  // the door generator stands inside `await deliveries.next()`, not on a `yield`.
  departed.abort();
  await response.body?.cancel().catch(() => {});

  expect(await until(async () => (await activeSubscriptions()) === before)).toBe(true);
});
