/**
 * A refusal has two dimensions, and this file exists because collapsing them costs real behaviour:
 * a node at its concurrency ceiling and a command outside its allowlist both arrive as `denied`,
 * yet one clears itself in milliseconds and the other never will. Everything asserted here is the
 * property a client needs before it can decide between "retry" and "tell a human".
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  type EventFrame,
  EventPublishSchema,
  type EventSubscribe,
} from '../packages/contracts/src/protocol/event.ts';
import {
  AdmissionSchema,
  HandshakeSchema,
  InvocationSchema,
  ResultSchema,
} from '../packages/contracts/src/protocol/rpc.ts';
import { EventRouter, type EventSink } from '../packages/runtime/src/broker/events.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { CommandProfileSchema, StreamProfileSchema } from '../packages/runtime/src/config/profiles.ts';
import { ExecutionAdmission } from '../packages/runtime/src/node/admission.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { EventConsumer } from '../packages/runtime/src/node/event-consumer.ts';
import { execute } from '../packages/runtime/src/node/exec.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { StreamConsumer, type StreamConsumerEvent } from '../packages/runtime/src/node/stream-consumer.ts';
import { brokerConfig, brokerHealth, freePort, until, waitConnected } from './support.ts';

const PORT = freePort();
const TOKEN_A = 'r'.repeat(40);
const TOKEN_B = 's'.repeat(40);

let broker: Awaited<ReturnType<typeof startBroker>>;
let caller: Agent;
let executor: Agent;

function invocation(input: { argv: string[]; stdin?: string | null; timeoutMs?: number }) {
  return InvocationSchema.parse({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: 'caller',
    to: 'executor',
    argv: input.argv,
    stdin: input.stdin ?? null,
    timeoutMs: input.timeoutMs ?? 1_000,
  });
}

beforeAll(async () => {
  broker = await startBroker(
    brokerConfig(
      { caller: TOKEN_A, executor: TOKEN_B },
      {
        port: PORT,
        // RPC only: a stream open from the same caller must be refused as policy, not as capacity.
        capabilities: { caller: [{ operation: 'peer', targets: ['executor'] }] },
        commandGrants: [
          { caller: 'caller', targets: ['executor'], command: 'echo' },
          { caller: 'caller', targets: ['executor'], command: 'strict' },
          { caller: 'caller', targets: ['executor'], command: 'wait' },
        ],
      },
    ),
  );
  const lane = (token: string) => ({
    brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token }],
    defaultTimeoutMs: 10_000,
  });
  caller = createAgent(NodeConfigSchema.parse({ ...lane(TOKEN_A), nodeId: 'caller', allow: {} }));
  executor = createAgent(
    NodeConfigSchema.parse({
      ...lane(TOKEN_B),
      nodeId: 'executor',
      allow: {
        echo: {
          bin: '/bin/echo',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
        strict: { bin: '/bin/echo', stdin: { mode: 'none' }, timeoutMs: 5_000 },
      },
    }),
  );
  await waitConnected(caller, executor);
});

afterAll(async () => {
  await caller?.stop();
  await executor?.stop();
  await broker?.stop();
});

test('a command outside the allowlist is a policy refusal, not a capacity one', async () => {
  const result = await caller.call({ to: 'executor', argv: ['nowhere'], stdin: null });
  expect(result.failure).toBe('denied');
  expect(result.refusal).toBe('policy');
  expect(result.retryAfterMs).toBeNull();
});

test('a request outside profile bounds is classified apart from both policy and capacity', async () => {
  const stdinRefused = await caller.call({ to: 'executor', argv: ['strict'], stdin: 'body' });
  expect(stdinRefused.failure).toBe('denied');
  expect(stdinRefused.refusal).toBe('request');

  const timeoutRefused = await caller.call({
    to: 'executor',
    argv: ['strict'],
    stdin: null,
    timeoutMs: 60_000,
  });
  expect(timeoutRefused.failure).toBe('denied');
  expect(timeoutRefused.refusal).toBe('request');
  expect(timeoutRefused.detail).toContain('timeout exceeds profile maximum');
});

test('a broker capability refusal for a whole operation stays policy', async () => {
  const events = caller.openStream({
    to: 'executor',
    profile: 'anything',
    args: [],
    stdin: null,
    cursor: null,
  });
  const first = await events.next();
  const event = first.value;
  if (event === undefined || !('failure' in event)) throw new Error('expected a stream failure event');
  expect(event.failure).toBe('denied');
  expect(event.refusal).toBe('policy');
});

test('node stream admission refuses over capacity with a class the caller can act on', async () => {
  const profile = StreamProfileSchema.parse({ bin: '/bin/cat', concurrency: 1 });
  const { streamExecutionAdmission } = await import('../packages/runtime/src/node/admission.ts');
  const gate = streamExecutionAdmission({
    admission: NodeConfigSchema.shape.admission.parse(undefined),
    streams: { tail: profile },
    services: { bindings: [], descriptors: [] },
  });
  const first = gate.acquire('tail');
  expect(first.accepted).toBe(true);
  const second = gate.acquire('tail');
  if (second.accepted) throw new Error('a second lease must not be granted at concurrency 1');
  expect(second.refused.failure).toBe('denied');
  expect(second.refused.refusal).toBe('capacity');
  expect(second.refused.retryAfterMs).toBeNull();
});

test('per-key execution admission is finite and reuses capacity after release', () => {
  const admission = new ExecutionAdmission(
    { maxInflight: 3 },
    { alpha: { concurrency: 1 }, beta: { concurrency: 1 } },
  );
  const alpha = admission.acquire('alpha');
  const beta = admission.acquire('beta');
  if (!alpha.accepted || !beta.accepted) throw new Error('fixture keys must be admitted');

  expect(admission.acquire('gamma')).toMatchObject({
    accepted: false,
    refused: { failure: 'denied', refusal: 'capacity' },
  });

  alpha.release();
  const gamma = admission.acquire('gamma');
  expect(gamma.accepted).toBe(true);
  if (gamma.accepted) gamma.release();
  beta.release();
});

test('a rate ceiling reports how long the caller must wait; a count ceiling reports nothing', async () => {
  const profile = CommandProfileSchema.parse({ bin: '/bin/echo', concurrency: 4 });
  const gate = new ExecutionAdmission({ maxInflight: 8, maxCallsPerMinute: 1 });
  const first = await execute(invocation({ argv: ['echo'] }), { echo: profile }, gate);
  expect(first.failure).toBe('none');

  const rated = await execute(invocation({ argv: ['echo'] }), { echo: profile }, gate);
  expect(rated.refusal).toBe('capacity');
  expect(rated.retryAfterMs ?? 0).toBeGreaterThan(0);
  expect(rated.retryAfterMs ?? 0).toBeLessThanOrEqual(60_000);

  const inflightGate = new ExecutionAdmission({ maxInflight: 1, maxCallsPerMinute: 600 }, { echo: profile });
  const held = inflightGate.acquire('echo');
  expect(held.accepted).toBe(true);
  const blocked = inflightGate.acquire('echo');
  if (blocked.accepted) throw new Error('inflight ceiling must refuse the second lease');
  expect(blocked.refused.refusal).toBe('capacity');
  expect(blocked.refused.retryAfterMs).toBeNull();
});

test('event refusals separate an allowlist from a full broker', () => {
  const sink: EventSink = {
    deliver: (_socket, _delivery, ack) => ack({ accepted: true, refusal: 'none', detail: '' }),
  };
  const config = brokerConfig(
    { publisher: 'p'.repeat(40), subscriber: 'q'.repeat(40), observer: 'r'.repeat(40) },
    {
      topics: {
        'generic.events': {
          producer: 'publisher',
          subscribers: ['subscriber', 'observer'],
          delivery: 'ordered',
          maxSubscribers: 1,
          maxEventsPerSecond: 1,
          maxEventBytes: 16,
        },
      },
    },
  );
  const router = new EventRouter(config, sink);
  const subscribe = (subscriber: string): EventSubscribe => ({
    subscriptionId: crypto.randomUUID(),
    topic: 'generic.events',
    subscriber,
    resume: null,
  });

  const outsider = router.subscribe(subscribe('publisher'), 'socket-x');
  expect(outsider.failure).toBe('denied');
  expect(outsider.refusal).toBe('policy');

  expect(router.subscribe(subscribe('subscriber'), 'socket-a').ok).toBe(true);
  // A SECOND session from the same node is the same machine and must pass: this is precisely the
  // shape a consumer restart takes, and refusing it made a node collide with its own previous self.
  expect(router.subscribe(subscribe('subscriber'), 'socket-b').ok).toBe(true);

  // A DIFFERENT node over the ceiling is a real capacity refusal — and it says who holds the slot,
  // because `capacity` without a name leaves an operator nothing to repair.
  const overSubscribed = router.subscribe(subscribe('observer'), 'socket-c');
  expect(overSubscribed.refusal).toBe('capacity');
  expect(overSubscribed.detail).toContain('1/1');
  expect(overSubscribed.detail).toContain('subscriber');

  const event = (seq: number, data: string) =>
    EventPublishSchema.parse({
      topic: 'generic.events',
      producer: 'publisher',
      bootId: crypto.randomUUID(),
      seq,
      observedAt: null,
      cursor: null,
      encoding: 'base64',
      data: Buffer.from(data).toString('base64'),
      bytes: Buffer.byteLength(data),
    });

  const oversized = router.publish('publisher', event(0, 'x'.repeat(64)), 'socket-p');
  expect(oversized.failure).toBe('denied');
  // Too large is permanent for THIS event and fixable by the publisher — neither policy nor capacity.
  expect(oversized.refusal).toBe('request');
});

test('the wire refuses envelopes whose two dimensions contradict each other', () => {
  const valid = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: 'executor',
    code: 1,
    stdout: '',
    stderr: '',
    failure: 'denied',
    refusal: 'capacity',
    retryAfterMs: 1_000,
    transportCause: null,
    detail: 'node rate limit reached',
    truncated: false,
  };
  expect(ResultSchema.safeParse(valid).success).toBe(true);
  // A retry hint on a refusal that will never clear would send a client into a pointless loop.
  expect(ResultSchema.safeParse({ ...valid, refusal: 'policy' }).success).toBe(false);
  // A classified refusal on a successful call would make `failure: 'none'` unreadable.
  expect(
    ResultSchema.safeParse({ ...valid, failure: 'none', refusal: 'capacity', retryAfterMs: null }).success,
  ).toBe(false);
  expect(
    AdmissionSchema.safeParse({
      accepted: false,
      failure: 'denied',
      refusal: 'capacity',
      retryAfterMs: null,
      transportCause: null,
      detail: 'inflight limit reached',
    }).success,
  ).toBe(true);
});

test('an envelope missing a classified field is refused, not silently completed', () => {
  // The tolerance that used to live here — a missing `refusal` defaulting to 'none' — existed for a
  // peer on an older release. There is no such peer: the handshake matches on the version, so a
  // frame that reaches a schema came from this exact build. A field missing now is our own bug, and
  // quietly inventing 'none' for it would hide a denial as a plain failure.
  const withoutRefusal = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: 'executor',
    code: 1,
    stdout: '',
    stderr: '',
    failure: 'denied',
    detail: "'nowhere' is not in this node's allowlist",
    truncated: false,
  };
  expect(ResultSchema.safeParse(withoutRefusal).success).toBe(false);

  expect(
    AdmissionSchema.safeParse({
      accepted: false,
      failure: 'denied',
      transportCause: null,
      detail: 'inflight limit reached for caller',
    }).success,
  ).toBe(false);

  // With the field present it parses, and the classification survives.
  const classified = ResultSchema.parse({
    ...withoutRefusal,
    refusal: 'policy',
    retryAfterMs: null,
    transportCause: null,
  });
  expect(classified.refusal).toBe('policy');
  expect(ResultSchema.safeParse({ ...classified, transportCause: undefined }).success).toBe(false);
});

test('a node publishes the ceilings a caller can hit instead of only enforcing them', async () => {
  const status = await executor.status();
  const admission = status.admission;
  if (admission === undefined) throw new Error('a current agent must publish its admission ceilings');
  expect(admission.maxInflight).toBeGreaterThan(0);
  expect(admission.maxCallsPerMinute).toBeGreaterThan(0);
  expect(admission.maxStreamBufferedBytes).toBeGreaterThan(0);
  expect(admission.maxEventSubscriptions).toBeGreaterThan(0);
  const strict = status.allow.find((entry) => entry.name === 'strict');
  expect(strict?.concurrency).toBeGreaterThan(0);
});

test('a stream refused by a broker ceiling ends at a LIMIT, not at an error', async () => {
  // The class and the terminal reason must agree: a consumer routing on `reason` would otherwise
  // draw a busy broker as a broken one, which is the exact confusion this whole change removes.
  const port = freePort();
  const brokerToken = 'y'.repeat(40);
  const producerToken = 'z'.repeat(40);
  const capped = await startBroker(
    brokerConfig(
      { caller: brokerToken, executor: producerToken },
      {
        port,
        capabilities: { caller: [{ operation: 'stream', targets: ['executor'] }] },
        admission: { maxStreamsTotal: 1 },
      },
    ),
  );
  const lane = (token: string) => ({
    brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token }],
    defaultTimeoutMs: 10_000,
  });
  const streamCaller = createAgent(
    NodeConfigSchema.parse({ ...lane(brokerToken), nodeId: 'caller', allow: {} }),
  );
  const producer = createAgent(
    NodeConfigSchema.parse({
      ...lane(producerToken),
      nodeId: 'executor',
      allow: {},
      streams: { slow: { bin: '/bin/sleep', argv: ['5'], concurrency: 4 } },
    }),
  );
  try {
    await waitConnected(streamCaller, producer);
    const held = streamCaller.openStream({
      to: 'executor',
      profile: 'slow',
      args: [],
      stdin: null,
      cursor: null,
    });
    const first = held.next();
    // The ceiling is one stream: the second open is refused only once the broker holds the first.
    expect(await until(async () => (await brokerHealth(port)).streams.active === 1)).toBe(true);
    const second = streamCaller.openStream({
      to: 'executor',
      profile: 'slow',
      args: [],
      stdin: null,
      cursor: null,
    });
    const refusedEvent = (await second.next()).value;
    if (refusedEvent === undefined || !('failure' in refusedEvent)) {
      throw new Error('expected the second open to be refused');
    }
    expect(refusedEvent.refusal).toBe('capacity');
    expect(refusedEvent.reason).toBe('limit');
    expect(refusedEvent.detail).toContain('registry limit');
    await second.return?.();
    await held.return?.();
    await first.catch(() => undefined);
  } finally {
    await streamCaller.stop();
    await producer.stop();
    await capped.stop();
  }
});

test('a consumer buffer overflow keeps its own failure code and gains a class', async () => {
  // Nothing refused this stream: the local buffer filled mid-flight. The code stays `rejected`,
  // where it always was — only the class is new.
  const events: StreamConsumerEvent[] = [];
  const consumer = new StreamConsumer(
    crypto.randomUUID(),
    'caller',
    16,
    {
      window: async () => ({ ok: true, detail: '' }),
      cancel: async () => ({ ok: true, detail: '' }),
    },
    () => {},
  );
  const payload = Buffer.from('x'.repeat(64)).toString('base64');
  consumer.pushChunk({
    streamId: consumer.streamId,
    from: 'executor',
    seq: 0,
    channel: 'data',
    encoding: 'base64',
    data: payload,
    bytes: 64,
    cursor: null,
  });
  for await (const event of consumer) {
    events.push(event);
    break;
  }
  const failure = events[0];
  if (failure === undefined || !('failure' in failure)) throw new Error('expected a failure event');
  expect(failure.failure).toBe('rejected');
  expect(failure.refusal).toBe('capacity');
  expect(failure.reason).toBe('limit');
});

test('a subscriber tells the broker which kind of no its delivery refusal is', () => {
  const consumer = new EventConsumer(
    crypto.randomUUID(),
    'generic.events',
    'subscriber',
    1,
    { unsubscribe: async () => {} },
    () => {},
  );
  const frame = (seq: number): EventFrame => ({
    subscriptionId: consumer.subscriptionId,
    topic: 'generic.events',
    producer: 'publisher',
    bootId: crypto.randomUUID(),
    seq,
    observedAt: null,
    cursor: null,
    encoding: 'base64',
    data: Buffer.from('x').toString('base64'),
    bytes: 1,
  });
  expect(consumer.push(frame(0)).accepted).toBe(true);
  const full = consumer.push(frame(1));
  expect(full.accepted).toBe(false);
  // The subscription is healthy and the producer can act on this — it is not "the subscriber is gone".
  expect(full.refusal).toBe('capacity');
});

test('a topic rate ceiling names its own window, which is a second, not a minute', () => {
  const sink: EventSink = {
    deliver: (_socket, _delivery, ack) => ack({ accepted: true, refusal: 'none', detail: '' }),
  };
  const config = brokerConfig(
    { publisher: 'p'.repeat(40), subscriber: 'q'.repeat(40) },
    {
      topics: {
        'generic.events': {
          producer: 'publisher',
          subscribers: ['subscriber'],
          delivery: 'ordered',
          maxEventsPerSecond: 1,
        },
      },
    },
  );
  const router = new EventRouter(config, sink);
  const bootId = crypto.randomUUID();
  const event = (seq: number) =>
    EventPublishSchema.parse({
      topic: 'generic.events',
      producer: 'publisher',
      bootId,
      seq,
      observedAt: null,
      cursor: null,
      encoding: 'base64',
      data: Buffer.from(`e${seq}`).toString('base64'),
      bytes: 2,
    });
  expect(router.publish('publisher', event(0), 'socket-p').ok).toBe(true);
  // The first publish opens the epoch and fills the one-per-second budget; the next one waits.
  const rated = router.publish('publisher', event(1), 'socket-p');
  expect(rated.refusal).toBe('capacity');
  expect(rated.retryAfterMs ?? 0).toBeGreaterThan(0);
  expect(rated.retryAfterMs ?? 0).toBeLessThanOrEqual(1_000);
});

test('a protocol mismatch is refused at the handshake instead of being dropped mid-flight', () => {
  const handshake = {
    nodeId: 'caller',
    token: 't'.repeat(40),
    serves: true,
    version: '0.8.0',
  };
  expect(HandshakeSchema.safeParse({ ...handshake }).success).toBe(true);
  // A protocol-1 node cannot reach the contract layer of a protocol-2 broker: it is turned away at
  // connect time, loudly, instead of having its frames dropped later without a word.
  expect(HandshakeSchema.safeParse({ v: 1, ...handshake }).success).toBe(false);
});

test('a withdrawn call stops the work, not just the waiting', async () => {
  const { execute } = await import('../packages/runtime/src/node/exec.ts');
  const { ExecutionAdmission } = await import('../packages/runtime/src/node/admission.ts');
  const { CommandProfileSchema } = await import('../packages/runtime/src/config/profiles.ts');
  // A duration nothing else on this machine is likely to be sleeping for, so `pgrep` is answering
  // about our child and not about somebody else's.
  const marker = '2971';
  const alive = async (): Promise<boolean> => {
    const probe = Bun.spawn(['pgrep', '-f', `sleep ${marker}`], { stdout: 'pipe', stderr: 'ignore' });
    const text = await new Response(probe.stdout).text();
    await probe.exited;
    return text.trim() !== '';
  };
  expect(await alive()).toBe(false);

  const withdrawal = new AbortController();
  const running = execute(
    {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      from: 'caller',
      to: 'worker',
      argv: ['wait'],
      stdin: null,
      // Fifteen minutes: without cancellation this is exactly how long the child would outlive a
      // caller who walked away, which is the leak this test exists for.
      timeoutMs: 900_000,
    },
    { wait: CommandProfileSchema.parse({ bin: '/bin/sleep', argv: [marker], timeoutMs: 900_000 }) },
    new ExecutionAdmission({ maxInflight: 2 }),
    withdrawal.signal,
  );
  expect(await until(alive)).toBe(true);

  withdrawal.abort();
  const result = await running;
  expect(result.failure).toBe('cancelled');
  expect(result.detail).toContain('withdrew');
  // The process group is signalled and awaited before the result returns, so by the time the caller
  // has an answer the work is already gone — not merely no longer listened to.
  expect(await alive()).toBe(false);
});
