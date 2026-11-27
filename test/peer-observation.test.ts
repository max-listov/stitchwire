import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PeerProbes } from '../packages/runtime/src/broker/peer-probes.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { AgentHandle } from '../packages/runtime/src/node/agent-contract.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { PeerObserver, type PeerRoute } from '../packages/runtime/src/node/peer-observation.ts';
import { PeerObservationSchema, type PeerReply } from '../packages/contracts/src/peer-contract.ts';
import { brokerConfig, freePort, until } from './support.ts';

test('peer echo authenticates exact target socket, times out and frees bounded slots', async () => {
  const replies: PeerReply[] = [];
  const router = new PeerProbes((_socket, event, reply) => {
    if (event === 'result') replies.push(reply);
  }, 15);
  try {
    const id = crypto.randomUUID();
    router.open('caller', 'caller', 'target', true, id);
    router.answer('impostor', id);
    expect(replies).toEqual([]);
    router.answer('target', id);
    expect(replies.at(-1)?.outcome).toBe('ok');
    router.open('caller', 'caller', undefined, false, crypto.randomUUID());
    expect(replies.at(-1)?.outcome).toBe('denied');
    router.open('caller', 'caller', undefined, true, crypto.randomUUID());
    expect(replies.at(-1)?.outcome).toBe('offline');
    for (let i = 0; i < 9; i++) router.open('caller', 'caller', 'target', true, crypto.randomUUID());
    expect(replies.at(-1)?.outcome).toBe('capacity');
    expect(await until(() => replies.filter((r) => r.outcome === 'timeout').length >= 8)).toBe(true);
    expect(replies.filter((r) => r.outcome === 'timeout')).toHaveLength(8);
    router.open('caller', 'caller', 'target', true, crypto.randomUUID());
    router.disconnect('target');
    expect(replies.at(-1)?.outcome).toBe('offline');
  } finally {
    router.stop();
  }
});

test('single flight, delay, stale, route change, failed samples and finite demand rate', async () => {
  let time = 0,
    epoch = '1',
    calls = 0;
  const observer = new PeerObserver('caller', () => time);
  const route: PeerRoute = {
    id: 'primary',
    url: 'http://127.0.0.1',
    epoch: () => epoch,
    probe: async () => {
      calls++;
      await Bun.sleep(5);
      time += 40;
      return 'ok';
    },
  };
  const request = { to: 'worker', mode: 'observe' } satisfies Parameters<PeerObserver['read']>[0];
  const five = await Promise.all(Array.from({ length: 5 }, () => observer.read(request, route)));
  if (five[0] === undefined) throw new Error('single-flight readers returned no observation');
  expect(calls).toBe(1);
  expect(five[0]).toMatchObject({ outcome: 'ok', latestMs: 40, medianMs: 40, sampleCount: 1 });
  expect(await observer.read(request, route)).toEqual(five[0]);
  time += 5_001;
  expect(await observer.read({ ...request, mode: 'cached' }, route)).toMatchObject({
    outcome: 'stale',
    latestMs: null,
    sampleCount: 0,
  });
  expect(calls).toBe(1);
  await observer.read(request, route);
  expect(calls).toBe(2);
  epoch = '2';
  expect(await observer.read({ ...request, mode: 'cached' }, route)).toMatchObject({
    outcome: 'stale',
    observedAt: null,
  });
  const changed = await observer.read(request, route);
  expect(changed.sampleCount).toBe(1);
  time += 5_001;
  const failed = await observer.read(request, { ...route, probe: async () => 'timeout' });
  expect(failed).toMatchObject({ outcome: 'timeout', latestMs: null, medianMs: null, sampleCount: 0 });
  // Unknown targets cannot turn the cache into an unbounded probe fan-out.
  for (let i = 0; i < 56; i++)
    await observer.read({ ...request, to: `n-${i}` }, { ...route, probe: async () => 'offline' });
  expect((await observer.read({ ...request, to: 'over-limit' }, route)).outcome).toBe('capacity');
});

test('route invalidation during flight cannot overwrite a newer cache entry', async () => {
  const observer = new PeerObserver('caller');
  let epoch = 'a';
  let finish: (value: 'ok') => void = () => {};
  const route: PeerRoute = {
    id: 'a',
    url: 'http://127.0.0.1',
    epoch: () => epoch,
    probe: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  const req = { to: 'worker', mode: 'observe' } satisfies Parameters<PeerObserver['read']>[0];
  const old = observer.read(req, route);
  epoch = 'b';
  const current = await observer.read(req, { ...route, probe: async () => 'ok' });
  finish('ok');
  expect((await old).outcome).toBe('stale');
  expect(await observer.read(req, route)).toMatchObject({
    observedAt: current.observedAt,
    latestMs: current.latestMs,
    route: current.route,
  });
});

const root = mkdtempSync(join(tmpdir(), 'wire-peer-door-'));
const token = 'p'.repeat(40),
  ports = [freePort(), freePort()];
const brokers: Awaited<ReturnType<typeof startBroker>>[] = [];
let caller: AgentHandle, worker: AgentHandle;
const workerServes = async () => (await caller.status()).nodes.some((n) => n.nodeId === 'worker' && n.serves);
beforeAll(async () => {
  for (const port of ports)
    brokers.push(
      await startBroker(
        brokerConfig(
          { caller: token, worker: token, absent: token },
          {
            port,
            capabilities: { caller: [{ operation: 'peer', targets: ['worker', 'absent'] }] },
            commandGrants: [{ caller: 'caller', targets: ['worker', 'absent'], command: 'echo' }],
          },
        ),
      ),
    );
  caller = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'caller',
      agentSocket: join(root, 'caller.sock'),
      brokers: ports.map((port, i) => ({ id: `lane-${i}`, url: `http://127.0.0.1:${port}`, token })),
    }),
  );
  worker = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      agentSocket: join(root, 'worker.sock'),
      brokers: [{ id: 'second', url: `http://127.0.0.1:${ports[1]}`, token }],
    }),
  );
  if (!(await until(workerServes))) throw new Error('fixture worker failed to appear');
});
afterAll(async () => {
  await caller?.stop();
  await worker?.stop();
  for (const broker of brokers) await broker.stop();
});

test('real Unix door selects serving alternate, supports exact lanes and explicit negative outcomes', async () => {
  const query = async (body: unknown) => {
    const res = await fetch('http://localhost/wire/peer-observation', {
      unix: caller.socketPath,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return PeerObservationSchema.parse(await res.json());
  };
  const first = await query({ to: 'worker' });
  expect(first).toMatchObject({
    observer: 'caller',
    target: 'worker',
    outcome: 'ok',
    route: { id: 'lane-1' },
    sampleCount: 1,
  });
  expect(first.latestMs).toBeGreaterThan(0);
  expect(await query({ to: 'worker' })).toMatchObject({
    observedAt: first.observedAt,
    latestMs: first.latestMs,
    sampleCount: 1,
  });
  expect((await query({ to: 'worker', route: 'lane-0' })).outcome).toBe('offline');
  expect((await query({ to: 'absent' })).outcome).toBe('offline');
  expect((await query({ to: 'caller' })).outcome).toBe('denied');
  expect((await query({ to: 'worker', route: 'not-declared' })).outcome).toBe('unsupported');
  await worker.stop();
  expect(await until(async () => !(await workerServes()))).toBe(true);
  expect((await query({ to: 'worker', route: 'lane-1', mode: 'cached' })).outcome).toBe('stale');
  worker = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      agentSocket: join(root, 'worker.sock'),
      brokers: [{ id: 'second', url: `http://127.0.0.1:${ports[1]}`, token }],
    }),
  );
  expect(await until(workerServes)).toBe(true);
  const reconnected = await query({ to: 'worker', route: 'lane-1' });
  expect(reconnected.outcome).toBe('ok');
  expect(reconnected.route?.epoch).not.toBe(first.route?.epoch);
  expect(reconnected.sampleCount).toBe(1);
});
