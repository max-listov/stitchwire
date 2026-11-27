import { beforeAll, afterAll, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { PublicationTraceSchema } from '../packages/runtime/src/node/publication-trace.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import type { AgentHandle } from '../packages/runtime/src/node/agent-contract.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { createWireClient, type WireClient } from '../packages/client/src/index.ts';
import { brokerConfig, freePort, until, waitConnected } from './support.ts';

const root = mkdtempSync(join(tmpdir(), 'wire-sdk-integration-'));
const port = freePort();
const topic = 'generic.observations';
const callerToken = 'sdk-caller-token'.repeat(3);
const workerToken = 'sdk-worker-token'.repeat(3);
let broker: Awaited<ReturnType<typeof startBroker>>;
let caller: AgentHandle;
let worker: AgentHandle;
let client: WireClient;
let publisher: WireClient;

beforeAll(async () => {
  broker = await startBroker(
    brokerConfig(
      { caller: callerToken, worker: workerToken },
      {
        port,
        capabilities: {
          caller: [
            { operation: 'peer', targets: ['worker'] },
            { operation: 'stream', targets: ['worker'] },
            { operation: 'subscribe', targets: ['worker'] },
          ],
          worker: [{ operation: 'publish', targets: ['worker'] }],
        },
        commandGrants: [{ caller: 'caller', targets: ['worker'], command: 'echo' }],
        topics: { [topic]: { producer: 'worker', subscribers: ['caller'], delivery: 'ordered' } },
      },
    ),
  );
  worker = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers: [{ id: 'test', url: `http://127.0.0.1:${port}`, token: workerToken }],
      agentSocket: join(root, 'worker.sock'),
      allow: {
        echo: {
          bin: '/bin/echo',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
      },
      streams: { logs: { bin: '/bin/echo', argv: ['prepared-log'], timeoutMs: 30_000 } },
      events: { publish: [topic], subscribe: [] },
    }),
  );
  caller = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'caller',
      brokers: [{ id: 'test', url: `http://127.0.0.1:${port}`, token: callerToken }],
      agentSocket: join(root, 'caller.sock'),
      events: { publish: [], subscribe: [topic] },
    }),
  );
  client = createWireClient({ socketPath: join(root, 'caller.sock') });
  publisher = createWireClient({ socketPath: join(root, 'worker.sock') });
  // Prove the predicate on the initial state before using it as a wait condition.
  expect(typeof caller.connected).toBe('boolean');
  await waitConnected(caller, worker);
});

afterAll(async () => {
  client?.close();
  publisher?.close();
  const errors = spyOn(console, 'error');
  try {
    await caller?.stop();
    await worker?.stop();
    expect(
      errors.mock.calls.flat().some((value) => String(value).includes("resource 'publication-audit' failed")),
    ).toBe(false);
  } finally {
    errors.mockRestore();
  }
  await broker?.stop();
  rmSync(root, { recursive: true, force: true });
});

test('SDK calls a real remote agent through the broker and preserves policy refusal', async () => {
  const reply = await client.call({ to: 'worker', argv: ['echo', 'sdk-proof'] });
  expect(reply.failure).toBe('none');
  expect(reply.stdout).toBe('sdk-proof\n');
  const denied = await client.call({ to: 'worker', argv: ['not-declared'] });
  expect(denied.failure).toBe('denied');
  expect(denied.refusal).toBe('policy');
  const status = await client.status();
  expect(status.nodeId).toBe('caller');
  expect(status.connected).toBe(true);
});

test('SDK consumes an actual bounded remote stream and peer observation', async () => {
  const items = [];
  for await (const item of client.stream({ to: 'worker', profile: 'logs' })) items.push(item);
  expect(items.at(-1)?.kind).toBe('end');
  expect(
    items
      .filter((item) => item.kind === 'chunk')
      .map((item) => new TextDecoder().decode(item.data))
      .join(''),
  ).toBe('prepared-log\n');
  const observation = await client.peerObservation({ to: 'worker' });
  expect(observation.outcome).toBe('ok');
  expect(observation.target).toBe('worker');
});

test('SDK publication arrives through subscribed door; cancellation frees real admission', async () => {
  const feed = client.subscribe({ topic });
  const pending = feed.next();
  expect((await client.status()).events.activeSubscriptions).toBeGreaterThanOrEqual(0);
  expect(await until(async () => (await client.status()).events.activeSubscriptions === 1)).toBe(true);
  const ack = await publisher.publish({ topic, bootId: crypto.randomUUID(), seq: 0, data: '{"sample":1}' });
  expect(ack.ok).toBe(true);
  const first = await pending;
  expect(first.value?.kind).toBe('event');
  if (!first.done && first.value.kind === 'event')
    expect(new TextDecoder().decode(first.value.data)).toBe('{"sample":1}');
  const quiet = feed.next().catch((error: unknown) => error);
  await feed.return?.();
  expect(await quiet).toMatchObject({ code: 'cancelled' });
  expect(await until(async () => (await client.status()).events.activeSubscriptions === 0)).toBe(true);
  const audit = (await publisher.status()).publicationAudit;
  expect(audit?.dropped).toBe(0);
  expect(audit?.writeFailures).toBe(0);
  expect(await until(async () => (await publisher.status()).publicationAudit?.queued === 0)).toBe(true);
  if (!audit) throw new Error('publication audit missing');
  const lines = (await readFile(audit.journal.path, 'utf8')).trim().split('\n');
  const phases = lines.map((line) => PublicationTraceSchema.strip().parse(JSON.parse(line).event));
  expect(phases.map((record) => record.phase)).toEqual([
    'door-received',
    'lane-dispatch',
    'engine-handoff',
    'engine-ack-received',
    'settled',
    'lane-result',
    'door-response-ready',
  ]);
  expect(phases.every((record) => record.topic === topic && record.seq === 0)).toBe(true);
  expect(new Set(phases.map((record) => record.bootId)).size).toBe(1);
  expect(phases.at(-1)?.outcome).toBe('accepted');
  expect(lines.join('')).not.toContain('sample');
});
