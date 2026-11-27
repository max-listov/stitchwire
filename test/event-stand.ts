import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrokerHandle } from '../packages/runtime/src/broker/contracts.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import type { EventDelivery } from '../packages/runtime/src/node/event-consumer.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { brokerConfig, brokerLane, freePort, until } from './support.ts';

/**
 * A producer that owns one topic namespace, readers that may subscribe in it, and a real broker
 * between them. The producer's topics are a descriptor file the test rewrites, as an owner's
 * installer would; the broker learns each version through the producer's declaration.
 */

export const NAMESPACE = 'owner.producer.';
export const TOPIC = `${NAMESPACE}metrics`;
/** How often the declaration file is re-read here; a node polls every five seconds. */
const POLL_MS = 100;
const PRODUCER_TOKEN = 'p'.repeat(40);

const pendingFrames = new WeakMap<
  AsyncIterableIterator<EventDelivery>,
  Promise<IteratorResult<EventDelivery>>
>();

/**
 * The next event, gap or terminal error of a subscription, or `'timeout'` when none arrives within
 * `budgetMs`. A timed observation keeps its pending read: a timeout is not iterator cancellation.
 */
export async function nextFrame(
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
    if ('seq' in next.value || 'failure' in next.value || 'reason' in next.value) return next.value;
  }
  return 'timeout';
}

export interface EventStand {
  readonly broker: BrokerHandle;
  readonly producer: Agent;
  /** The broker's port, for a test that speaks to the broker itself. */
  readonly port: number;
  /** The descriptor files the producer reads: the first is the one `describe` and `withdraw` write, the rest start empty. */
  readonly descriptors: readonly string[];
  /** Writes the producer's descriptor: its one topic, readable by `subscribers`, with `profile` as its profile. */
  describe(subscribers: string[], profile?: Record<string, unknown>): void;
  /** Replaces the topic with another one in the descriptor: the producer stops declaring `TOPIC`. */
  withdraw(): void;
  /** The token of a reader of this stand, for a test that connects as that node by itself. */
  token(nodeId: string): string;
  /** A reader node that may subscribe in the namespace. */
  reader(nodeId: string, admission?: Record<string, unknown>): Agent;
  /** Waits until the producer's newest declaration, made after `after`, was accepted by the broker. */
  declared(after: string): Promise<boolean>;
  /** The time of the producer's newest declaration answer, to pass to `declared` after an edit. */
  declaredAt(): Promise<string>;
  /** Publishes one event of the topic. */
  publish(bootId: string, seq: number): ReturnType<Agent['publishEvent']>;
  stop(): Promise<void>;
}

/** `extraDescriptors` is how many more descriptor files the producer reads beside the first. */
export async function startEventStand(readers: readonly string[], extraDescriptors = 0): Promise<EventStand> {
  const root = mkdtempSync(join(tmpdir(), 'wire-event-stand-'));
  const port = freePort();
  const tokens: Record<string, string> = { producer: PRODUCER_TOKEN };
  for (const name of readers) tokens[name] = name.padEnd(40, 'r').slice(0, 40);
  const broker = await startBroker(
    brokerConfig(tokens, {
      port,
      capabilities: {
        producer: [{ operation: 'publish', targets: ['producer'] }],
        ...Object.fromEntries(
          readers.map((name) => [name, [{ operation: 'subscribe' as const, targets: ['producer'] }]]),
        ),
      },
      topicNamespaces: { [NAMESPACE]: { producer: 'producer', subscribers: [...readers], maxTopics: 3 } },
    }),
  );
  const descriptor = join(root, 'descriptor.json');
  const describe: EventStand['describe'] = (subscribers, profile = {}) =>
    writeFileSync(
      descriptor,
      JSON.stringify({ topics: { [TOPIC]: { delivery: 'ordered', subscribers, ...profile } } }),
    );
  describe([...readers]);
  const descriptors = [descriptor];
  for (let index = 1; index <= extraDescriptors; index += 1) {
    const extra = join(root, `descriptor-${index}.json`);
    writeFileSync(extra, JSON.stringify({ topics: {} }));
    descriptors.push(extra);
  }
  const producer = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'producer',
      brokers: brokerLane(port, PRODUCER_TOKEN),
      events: { namespaces: { publish: [NAMESPACE] }, descriptors },
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { declarationPollMs: POLL_MS },
  );
  const agents: Agent[] = [producer];
  const declaredAt = async () => (await producer.status()).events.declarations.lanes[0]?.declaredAt ?? '';
  return {
    broker,
    producer,
    port,
    descriptors,
    describe,
    withdraw: () =>
      writeFileSync(
        descriptor,
        JSON.stringify({
          topics: { [`${NAMESPACE}other`]: { delivery: 'ordered', subscribers: [...readers] } },
        }),
      ),
    token: (nodeId) => {
      const token = tokens[nodeId];
      if (token === undefined) throw new Error(`'${nodeId}' is not a node of this stand`);
      return token;
    },
    reader: (nodeId, admission = {}) => {
      const token = tokens[nodeId];
      if (token === undefined) throw new Error(`'${nodeId}' is not a reader of this stand`);
      const agent = createAgent(
        NodeConfigSchema.parse({
          nodeId,
          brokers: brokerLane(port, token),
          events: { namespaces: { subscribe: [NAMESPACE] } },
          admission,
        }),
      );
      agents.push(agent);
      return agent;
    },
    declaredAt,
    declared: (after) =>
      until(async () => {
        const answer = (await producer.status()).events.declarations.lanes[0];
        return answer !== undefined && answer.declaredAt > after;
      }),
    publish: (bootId, seq) =>
      producer.publishEvent({
        topic: TOPIC,
        bootId,
        seq,
        observedAt: null,
        cursor: null,
        data: `event-${seq}`,
      }),
    stop: async () => {
      await Promise.all(agents.map((agent) => agent.stop()));
      await broker.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
