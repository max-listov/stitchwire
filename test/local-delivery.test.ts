/**
 * A publish on the same machine as its subscriber must not go abroad first.
 *
 * Reported by the consumer that noticed it, with the two numbers that made it a defect rather than
 * an architectural opinion: 124 ms from a genuinely remote publisher, **467 ms from the same node**
 * as the subscriber. Four times slower for being closer, because the local case was not local at
 * all — and, worse than the latency, delivery inside one machine depended on reaching a machine in
 * another country.
 *
 * The ordering question the report raised is answered by the shape rather than by a caveat: local
 * delivery is one more SOURCE of the same consumer, so the merge that already reconciles two
 * brokers reconciles this too.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalEventDeliverySchema } from '../packages/contracts/src/door/results.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import type { AgentHandle } from '../packages/runtime/src/node/agent-contract.ts';
import { brokerConfig, freePort, waitConnected } from './support.ts';

const PORT = freePort();
const DEAD_PORT = freePort();
const TOKEN = 'd'.repeat(40);
const BOOT = crypto.randomUUID();
const root = mkdtempSync(join(tmpdir(), 'stitchwire-local-delivery-'));

let broker: Awaited<ReturnType<typeof startBroker>>;
let node: AgentHandle;
let isolated: AgentHandle;

function deliveryBroker() {
  return brokerConfig(
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
        'generic.events': {
          producer: 'worker',
          subscribers: ['worker'],
          delivery: 'ordered',
          maxSubscribers: 4,
        },
      },
    },
  );
}

function nodeConfig(port: number, socket: string) {
  return NodeConfigSchema.parse({
    brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token: TOKEN }],
    nodeId: 'worker',
    events: { publish: ['generic.events'], subscribe: ['generic.events'] },
    agentSocket: join(root, socket),
    ...(port === DEAD_PORT ? { admission: { publishAckTimeoutMs: 100 } } : {}),
  });
}

beforeAll(async () => {
  broker = await startBroker(deliveryBroker());
  node = await startAgent(nodeConfig(PORT, 'live.sock'));
  // Nothing listens on DEAD_PORT: this node can never reach a broker at all.
  isolated = await startAgent(nodeConfig(DEAD_PORT, 'isolated.sock'));
  await waitConnected(node);
});

afterAll(async () => {
  await isolated?.stop();
  await node?.stop();
  await broker?.stop();
});

function publish(seq: number, data = `event-${seq}`) {
  return { topic: 'generic.events', bootId: BOOT, seq, observedAt: null, cursor: null, data };
}

test('a node with no broker at all still delivers to its own subscriber', async () => {
  // The acceptance that matters most: delivery inside one machine must not depend on reaching
  // another one. Before this, an isolated node could not notify itself.
  const subscription = isolated.subscribeEvents({ topic: 'generic.events', resume: null });
  const ack = await isolated.publishEvent(publish(0, 'from an isolated node'));

  // `ok` keeps meaning exactly what it meant — did the brokers take it — so an isolated publish is
  // still false. Letting a local delivery flip it would make `ok` mean different things depending
  // on who happens to be subscribed.
  expect(ack.ok).toBe(false);
  expect(ack.failure).toBe('transport');
  // And the detail says the thing the boolean deliberately does not.
  expect(ack.detail).toContain('local subscriber');

  const delivery = await subscription.next();
  expect(delivery.done).toBe(false);
  const frame = delivery.value as { seq: number; data: string };
  expect(frame.seq).toBe(0);
  expect(Buffer.from(frame.data, 'base64').toString('utf8')).toBe('from an isolated node');
  await subscription.return?.();
});

test('a connected node delivers locally and the broker copy is dropped as the duplicate', async () => {
  const subscription = node.subscribeEvents({ topic: 'generic.events', resume: null });
  const ack = await node.publishEvent(publish(1, 'same machine'));
  expect(ack.ok).toBe(true);

  const first = await subscription.next();
  expect((first.value as { seq: number }).seq).toBe(1);

  // The broker's copy of sequence 1 arrives later. It must not be delivered twice — and the rule
  // that drops it is the same one that already reconciles two brokers, not a new one written here.
  const second = await Promise.race([
    subscription.next().then((r) => r.value as { seq?: number } | undefined),
    Bun.sleep(600).then(() => 'nothing else arrived' as const),
  ]);
  expect(second).toBe('nothing else arrived');
  await subscription.return?.();
});

test('the local copy arrives before the network could have carried it back', async () => {
  const subscription = node.subscribeEvents({ topic: 'generic.events', resume: null });
  const started = performance.now();
  void node.publishEvent(publish(2, 'timed'));
  const delivery = await subscription.next();
  const elapsed = performance.now() - started;

  expect((delivery.value as { seq: number }).seq).toBe(2);
  // Not a benchmark — a proof of path. A round trip through a broker cannot be this fast even on
  // loopback with a real handshake, and on the fleet the same trip measured 467 ms.
  expect(elapsed).toBeLessThan(50);
  await subscription.return?.();
});

test('order within the producer stream survives having two sources', async () => {
  const subscription = node.subscribeEvents({ topic: 'generic.events', resume: null });
  for (let seq = 10; seq <= 13; seq += 1) await node.publishEvent(publish(seq));
  const seen: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const delivery = await subscription.next();
    seen.push((delivery.value as { seq: number }).seq);
  }
  expect(seen).toEqual([10, 11, 12, 13]);
  await subscription.return?.();
});

test('a terminal refusal still reaches a consumer, though the local source never ends', async () => {
  // The defect this integration introduced and this test now prevents: the local source waits for
  // the next publish forever, and the merge only delivered a collected refusal once EVERY source
  // had finished. A denied consumer hung instead of being told it was denied.
  const subscription = node.subscribeEvents({ topic: 'not-a-declared-topic', resume: null });
  const denial = await Promise.race([subscription.next(), Bun.sleep(3_000).then(() => 'hung' as const)]);
  expect(denial).not.toBe('hung');
  const value = (denial as IteratorResult<unknown>).value as { failure?: string };
  expect(value.failure).toBe('denied');
  await subscription.return?.();
});

test('one real Unix subscription survives isolated publisher boots without reconnect', async () => {
  const controller = new AbortController();
  const res = await fetch('http://localhost/wire/events/subscribe', {
    unix: isolated.socketPath,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'generic.events' }),
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  if (!res.body) throw new Error('subscription body absent');
  const reader = res.body.getReader(),
    decoder = new TextDecoder();
  let buffered = '';
  const read = async () => {
    for (;;) {
      const end = buffered.indexOf('\n');
      if (end >= 0) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (line) return LocalEventDeliverySchema.parse(JSON.parse(line));
        continue;
      }
      const part = await reader.read();
      if (part.done) throw new Error('subscription closed before boot successor');
      buffered += decoder.decode(part.value, { stream: true });
    }
  };
  try {
    const old = crypto.randomUUID(),
      fresh = crypto.randomUUID();
    await isolated.publishEvent({ ...publish(10), bootId: old });
    expect(await read()).toMatchObject({ bootId: old, seq: 10 });
    await isolated.publishEvent({ ...publish(0), bootId: fresh });
    expect(await read()).toMatchObject({ reason: 'boot-change', bootId: old, nextBootId: fresh });
    expect(await read()).toMatchObject({ bootId: fresh, seq: 0 });
    await isolated.publishEvent({ ...publish(1), bootId: fresh });
    expect(await read()).toMatchObject({ bootId: fresh, seq: 1 });
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});
