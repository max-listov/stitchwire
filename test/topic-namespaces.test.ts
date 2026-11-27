import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventDeclareSchema } from '../packages/contracts/src/protocol/topic.ts';
import type { BrokerHandle } from '../packages/runtime/src/broker/contracts.ts';
import type { EventDelivery as BrokerDelivery } from '../packages/runtime/src/broker/event-subscriptions.ts';
import { EventRouter } from '../packages/runtime/src/broker/events.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import type { EventDelivery } from '../packages/runtime/src/node/event-consumer.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { brokerConfig, freePort, until } from './support.ts';

/**
 * An owner adds a topic by editing its own descriptor, and nobody else touches anything.
 *
 * The fleet grants a namespace to one producer; the producer's node reads the descriptor its owner
 * installed and tells each broker the complete set. These tests hold the three borders that make
 * that safe — one name has one producer, a namespace costs the broker a bounded amount, and a
 * declaration the broker refuses is refused per name with a reason — and the one property that
 * makes it self-service: a new topic reaches a subscriber on another node with no restart at all.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-topic-namespaces-'));
const TOKEN_PRODUCER = 'p'.repeat(40);
const TOKEN_READER = 'r'.repeat(40);
const TOKEN_OTHER = 'o'.repeat(40);
const NAMESPACE = 'owner.producer.';
/** How often the declaration files are re-read here; a node polls every five seconds. */
const POLL_MS = 100;

function namespaceBroker(port: number) {
  return brokerConfig(
    { producer: TOKEN_PRODUCER, reader: TOKEN_READER, other: TOKEN_OTHER },
    {
      port,
      capabilities: {
        producer: [{ operation: 'publish', targets: ['producer'] }],
        reader: [{ operation: 'subscribe', targets: ['producer'] }],
      },
      topicNamespaces: { [NAMESPACE]: { producer: 'producer', subscribers: ['reader'], maxTopics: 2 } },
    },
  );
}

function refusal(overrides: Record<string, unknown>): string {
  const parsed = BrokerConfigSchema.safeParse({
    nodes: [
      { id: 'producer', tokenSha256s: [sha256(TOKEN_PRODUCER)] },
      { id: 'reader', tokenSha256s: [sha256(TOKEN_READER)] },
      { id: 'other', tokenSha256s: [sha256(TOKEN_OTHER)] },
    ],
    ...overrides,
  });
  return parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join('\n');
}

const grant = (producer: string, maxTopics = 4) => ({ producer, subscribers: ['reader'], maxTopics });

describe('configuration keeps every name to one producer and the broker bounded', () => {
  test('two namespaces that could hold one name are refused', () => {
    expect(
      refusal({ topicNamespaces: { 'owner.': grant('producer'), 'owner.producer.': grant('other') } }),
    ).toContain('overlaps');
    expect(refusal({ topicNamespaces: { 'owner.a.': grant('producer'), 'owner.b.': grant('other') } })).toBe(
      '',
    );
  });

  test('a fleet topic inside another producer’s namespace is refused, inside its own it is not', () => {
    const topic = (producer: string) => ({ producer, subscribers: ['reader'], delivery: 'ordered' });
    expect(
      refusal({
        topicNamespaces: { [NAMESPACE]: grant('producer') },
        topics: { 'owner.producer.x': topic('other') },
      }),
    ).toContain('lies inside namespace');
    expect(
      refusal({
        topicNamespaces: { [NAMESPACE]: grant('producer') },
        topics: { 'owner.producer.x': topic('producer') },
      }),
    ).toBe('');
  });

  test('every namespace counts at its ceiling against the broker’s topic budget', () => {
    const fleetTopic = {
      'fixed.topic': { producer: 'producer', subscribers: ['reader'], delivery: 'ordered' },
    };
    expect(
      refusal({
        admission: { maxTopics: 2 },
        topics: fleetTopic,
        topicNamespaces: { [NAMESPACE]: grant('producer', 2) },
      }),
    ).toContain('topic count exceeds broker admission limit');
    expect(
      refusal({
        admission: { maxTopics: 3 },
        topics: fleetTopic,
        topicNamespaces: { [NAMESPACE]: grant('producer', 2) },
      }),
    ).toBe('');
  });

  test('a namespace ends where a name segment ends', () => {
    expect(refusal({ topicNamespaces: { 'owner.producer': grant('producer') } })).not.toBe('');
  });
});

describe('a broker judges each declared name on its own', () => {
  const declaration = (topics: Record<string, unknown>, producer = 'producer') =>
    EventDeclareSchema.parse({ producer, topics });

  test('inside the namespace is accepted; everything else is refused with its reason', () => {
    const router = new EventRouter(namespaceBroker(1), { deliver: () => {} });
    const ack = router.declare(
      'producer',
      declaration({
        'elsewhere.topic': { delivery: 'ordered' },
        'owner.producer.a': { delivery: 'ordered' },
        'owner.producer.b': { delivery: 'latest-wins' },
        'owner.producer.c': { delivery: 'ordered' },
        'owner.producer.d': { delivery: 'ordered', subscribers: ['other'] },
      }),
    );
    expect(ack.accepted).toEqual(['owner.producer.a', 'owner.producer.b']);
    const reasons = Object.fromEntries(ack.refused.map((entry) => [entry.topic, entry.detail]));
    expect(reasons['elsewhere.topic']).toContain('no namespace');
    expect(reasons['owner.producer.c']).toContain('at most 2 topics');
    expect(reasons['owner.producer.d']).toContain('does not admit other');
    expect(router.lookup('owner.producer.a')).toMatchObject({ state: 'declared', source: 'owner' });
    expect(router.topics(Date.now()).map((flow) => [flow.topic, flow.source])).toEqual([
      ['owner.producer.a', 'owner'],
      ['owner.producer.b', 'owner'],
    ]);
  });

  test('a node cannot declare for another producer, and a later declaration replaces the earlier one', () => {
    const router = new EventRouter(namespaceBroker(1), { deliver: () => {} });
    const spoof = router.declare('reader', declaration({ 'owner.producer.a': { delivery: 'ordered' } }));
    expect(spoof.accepted).toEqual([]);
    expect(router.lookup('owner.producer.a')).toMatchObject({ state: 'undeclared', producer: 'producer' });

    router.declare('producer', declaration({ 'owner.producer.a': { delivery: 'ordered' } }));
    router.declare('producer', declaration({ 'owner.producer.b': { delivery: 'ordered' } }));
    expect(router.lookup('owner.producer.a')).toMatchObject({ state: 'undeclared' });
    expect(router.lookup('owner.producer.b')).toMatchObject({ state: 'declared' });
    expect(router.lookup('unrelated.topic')).toEqual({ state: 'unknown' });
  });
  test('a topic its producer stops declaring tells its subscribers the producer is gone', () => {
    const delivered: BrokerDelivery[] = [];
    const router = new EventRouter(namespaceBroker(1), { deliver: (_socket, item) => delivered.push(item) });
    router.declare(
      'producer',
      declaration({
        'owner.producer.a': { delivery: 'ordered' },
        'owner.producer.b': { delivery: 'ordered' },
      }),
    );
    const subscribe = (topic: string) =>
      router.subscribe(
        { subscriptionId: crypto.randomUUID(), topic, subscriber: 'reader', resume: null },
        'socket-reader',
      );
    expect(subscribe('owner.producer.a').ok).toBe(true);
    expect(subscribe('owner.producer.b').ok).toBe(true);
    expect(router.status().subscriptions).toBe(2);

    // The later declaration drops `a` and keeps `b`: only `a`'s reader is told, and its slot is freed.
    router.declare('producer', declaration({ 'owner.producer.b': { delivery: 'ordered' } }));
    expect(router.status().subscriptions).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      kind: 'error',
      value: { failure: 'offline', transportCause: 'target-offline', topic: 'owner.producer.a' },
    });
    router.stop();
  });
});

const pendingFrames = new WeakMap<
  AsyncIterableIterator<EventDelivery>,
  Promise<IteratorResult<EventDelivery>>
>();

/** A timed observation keeps its pending read: timeout is not iterator cancellation. */
async function nextFrame(
  subscription: AsyncIterableIterator<EventDelivery>,
  budgetMs: number,
): Promise<EventDelivery | 'timeout'> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const pending = pendingFrames.get(subscription) ?? subscription.next();
    pendingFrames.set(subscription, pending);
    const next = await Promise.race([
      pending,
      Bun.sleep(Math.max(1, deadline - Date.now())).then((): 'timeout' => 'timeout'),
    ]);
    if (next === 'timeout') return 'timeout';
    pendingFrames.delete(subscription);
    if (next.done) return 'timeout';
    if ('seq' in next.value || 'failure' in next.value) return next.value;
  }
  return 'timeout';
}

describe('an owner adds a topic by editing its own descriptor', () => {
  const agents: Agent[] = [];
  let broker: BrokerHandle | undefined;

  afterAll(async () => {
    await Promise.all(agents.map((agent) => agent.stop()));
    await broker?.stop();
  });

  test('declared topics reach another node without a restart, and come back after the broker restarts', async () => {
    const port = freePort();
    const config = namespaceBroker(port);
    broker = await startBroker(config);
    const descriptor = join(root, 'topics.json');
    const describe = (topics: Record<string, unknown>) =>
      writeFileSync(descriptor, JSON.stringify({ topics }));
    describe({ 'owner.producer.metrics': { delivery: 'ordered' } });

    const lane = (token: string) => [
      {
        id: 'primary',
        url: `http://127.0.0.1:${port}`,
        token,
        reconnect: { minDelayMs: 100, maxDelayMs: 500 },
      },
    ];
    const producer = createAgent(
      NodeConfigSchema.parse({
        nodeId: 'producer',
        brokers: lane(TOKEN_PRODUCER),
        events: { namespaces: { publish: [NAMESPACE] }, descriptors: [descriptor] },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { declarationPollMs: POLL_MS },
    );
    const reader = createAgent(
      NodeConfigSchema.parse({
        nodeId: 'reader',
        brokers: lane(TOKEN_READER),
        events: { namespaces: { subscribe: [NAMESPACE] } },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { subscriptionRetry: { minDelayMs: 50, maxDelayMs: 400, jitter: 0.2 } },
    );
    agents.push(producer, reader);

    const declared = async (accepted: number) => {
      const answer = (await producer.status()).events.declarations.lanes[0];
      return answer?.accepted === accepted;
    };
    expect(await until(() => declared(1), 5_000)).toBe(true);
    expect(await until(() => reader.connected, 5_000)).toBe(true);

    const metrics = reader.subscribeEvents({ topic: 'owner.producer.metrics', resume: null });
    const boot = crypto.randomUUID();
    const publish = (topic: string, seq: number) =>
      producer.publishEvent({
        topic,
        bootId: boot,
        seq,
        observedAt: null,
        cursor: null,
        data: `${topic}-${seq}`,
      });
    // The first subscription may still be in flight; publish until a frame arrives.
    expect(await until(async () => (await publish('owner.producer.metrics', 0)).ok, 3_000)).toBe(true);
    expect(await nextFrame(metrics, 5_000)).toMatchObject({ topic: 'owner.producer.metrics', seq: 0 });

    // A name inside the namespace that nobody declared yet is waited for, not refused for good.
    const second = reader.subscribeEvents({ topic: 'owner.producer.second', resume: null });
    expect(await nextFrame(second, 600)).toBe('timeout');

    // The owner edits only its own file: two more names inside the namespace, one outside it.
    describe({
      'elsewhere.topic': { delivery: 'ordered' },
      'owner.producer.metrics': { delivery: 'ordered' },
      'owner.producer.second': { delivery: 'ordered' },
      'owner.producer.third': { delivery: 'ordered' },
    });
    expect(await until(() => declared(2), 12_000)).toBe(true);
    const declarations = (await producer.status()).events.declarations;
    expect(declarations.refused.map((entry) => entry.topic)).toEqual(['elsewhere.topic']);
    expect(declarations.lanes[0]?.refused.map((entry) => entry.topic)).toEqual(['owner.producer.third']);

    expect(await until(async () => (await publish('owner.producer.second', 0)).ok, 3_000)).toBe(true);
    let frame = await nextFrame(second, 1_000);
    // The waiting subscription retries on its own backoff, so the first frame may have been
    // published before it re-asked. Publish again in short steps; the loop bound is a ceiling on a
    // hang, not an expectation of how many steps it takes.
    for (let seq = 1; frame === 'timeout' && seq < 15; seq += 1) {
      await publish('owner.producer.second', seq);
      frame = await nextFrame(second, 1_000);
    }
    expect(frame).toMatchObject({ topic: 'owner.producer.second' });

    // A restarted broker knows nothing; the producer's reconnect tells it everything again.
    const before = (await producer.status()).events.declarations.lanes[0]?.declaredAt ?? '';
    await broker.stop();
    broker = await startBroker(config);
    expect(
      await until(async () => {
        const answer = (await producer.status()).events.declarations.lanes[0];
        return answer !== undefined && answer.declaredAt > before && answer.accepted === 2;
      }, 15_000),
    ).toBe(true);
    let after = 'timeout' as EventDelivery | 'timeout';
    for (let seq = 1; after === 'timeout' && seq < 15; seq += 1) {
      await publish('owner.producer.metrics', seq);
      after = await nextFrame(metrics, 1_000);
    }
    expect(after).toMatchObject({ topic: 'owner.producer.metrics' });
    await metrics.return?.();
    await second.return?.();
  }, 90_000);
});
