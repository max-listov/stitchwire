/**
 * Ready and healthy are different questions, and this is where they stop sharing an answer.
 *
 * A node whose every lane is down is READY: its door answers, and says `connected: false`. That is
 * the whole difference between a machine that reports its situation and one that hangs, and it is
 * why a lane is ready when its dialer runs rather than when a broker replies. It is also, plainly,
 * not HEALTHY — and until now that fact lived only in `connected`, a field nothing outside this
 * project's own CLI knew how to read.
 *
 * The kernel's verdict is published beside the domain, never merged into it: `ok` on the broker
 * remains what it always was, an audit fact.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { AgentHandle } from '../packages/runtime/src/node/agent-contract.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { LocalStatusSchema } from '../packages/contracts/src/door/status.ts';
import { brokerConfig, freePort, waitConnected } from './support.ts';

const LIVE_PORT = freePort();
const DEAD_PORT = freePort(); // deliberately nothing listening: the lane can never connect
const TOKEN = 'h'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'stitchwire-lifecycle-'));

let broker: Awaited<ReturnType<typeof startBroker>>;
let healthy: AgentHandle;
let orphan: AgentHandle;

function nodeConfig(port: number, socket: string) {
  return NodeConfigSchema.parse({
    brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token: TOKEN }],
    nodeId: 'worker',
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
    agentSocket: join(root, socket),
  });
}

async function status(socket: string): Promise<unknown> {
  const response = await fetch('http://localhost/wire/status', { unix: join(root, socket) });
  return await response.json();
}

beforeAll(async () => {
  broker = await startBroker(
    brokerConfig(
      { worker: TOKEN },
      {
        port: LIVE_PORT,
        auditPath: join(root, 'audit.jsonl'),
      },
    ),
  );
  healthy = await startAgent(nodeConfig(LIVE_PORT, 'live.sock'));
  orphan = await startAgent(nodeConfig(DEAD_PORT, 'orphan.sock'));
  await waitConnected(healthy);
});

afterAll(async () => {
  await orphan?.stop();
  await healthy?.stop();
  await broker?.stop();
});

test('an agent that reached no broker still answers its door, and says so', async () => {
  const answer = LocalStatusSchema.parse(await status('orphan.sock'));
  expect(answer.connected).toBe(false);
  expect(answer.lanes.every((lane) => !lane.connected)).toBe(true);
});

test('and its lifecycle separates "finished starting" from "everything is well"', async () => {
  const answer = LocalStatusSchema.parse(await status('orphan.sock'));
  const application = answer.application;
  if (application === undefined) throw new Error('the door published no lifecycle projection');
  expect(application.id).toBe('stitchwire-agent');
  // The process finished starting and is serving — this very answer proves it.
  expect(application.lifecycle).toBe('ready');
  // And right now a required part of it is not well. The kernel defines `ready` as "every required
  // resource is ready AND healthy", so for a required resource the two move together; the fact that
  // separates them is `lifecycle`, which stays `ready` because the door is up and answering.
  expect(application.ready).toBe(false);
  expect(application.health).toBe('unhealthy');
  expect(application.resources.total).toBeGreaterThanOrEqual(2);
});

test('a connected agent reports healthy through the same field', async () => {
  const answer = LocalStatusSchema.parse(await status('live.sock'));
  expect(answer.connected).toBe(true);
  expect(answer.application?.ready).toBe(true);
  expect(answer.application?.health).toBe('healthy');
});

test('the projection carries the verdict and never the topology', async () => {
  const answer = LocalStatusSchema.parse(await status('live.sock'));
  const application = answer.application as unknown as Record<string, unknown>;
  // Resource ids, dependency edges and admission counters stay inside the process, where
  // `getSnapshot()` keeps them. A status route that published them would be a map of the machine.
  for (const forbidden of ['resourceIds', 'dependsOn', 'epoch', 'admission', 'snapshot']) {
    expect(forbidden in application).toBe(false);
  }
  expect(Object.keys(application).sort()).toEqual([
    'capturedAt',
    'health',
    'id',
    'lifecycle',
    'ready',
    'resources',
  ]);
});

test('the broker publishes the same verdict beside `ok`, which stays an audit fact', async () => {
  const response = await fetch(`http://127.0.0.1:${LIVE_PORT}/health`);
  const body = (await response.json()) as {
    ok: boolean;
    application: { id: string; ready: boolean; health: string };
    audit: { dropped: number; writeFailures: number };
  };
  expect(body.application.id).toBe('stitchwire-broker');
  expect(body.application.ready).toBe(true);
  // `ok` never meant lifecycle: it is "the journal is losing nothing", and it keeps that meaning.
  // Replacing it would have broken every reader to remove an ambiguity it did not have.
  expect(body.ok).toBe(body.audit.dropped === 0 && body.audit.writeFailures === 0);
});

test('the server shuts down through its own adapter, and says so', async () => {
  // For two releases this was a hand-rolled `close: () => server.shutdown()`, because the
  // framework's adapter fed a whole-millisecond schema a fractional clock and failed every phase it
  // ran in — the shutdown ended `forced` with two validation failures. Adopting the fixed adapter
  // is only worth anything if the outcome is actually clean, so that is what is asserted.
  const failures: string[] = [];
  const own = await startBroker(
    brokerConfig(
      { worker: TOKEN },
      {
        port: freePort(),
        auditPath: join(root, 'shutdown-audit.jsonl'),
      },
    ),
  );
  const result = await own.stop();
  expect(result.outcome).toBe('clean');
  expect(result.resources.flatMap((resource) => resource.failures)).toEqual([]);
  expect(failures).toEqual([]);
  // Every resource reached a closed state rather than being abandoned at a deadline.
  expect(result.resources.every((resource) => resource.state === 'closed')).toBe(true);
});

test('a failed broker factory rolls back without closing the existing listener', async () => {
  const config = brokerConfig(
    { worker: TOKEN },
    {
      port: freePort(),
      auditPath: join(root, 'factory-audit.jsonl'),
    },
  );
  const first = await startBroker(config);
  try {
    const startedAt = performance.now();
    const failure = await startBroker(config).then(
      () => {
        throw new Error('second broker unexpectedly acquired the listener');
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(AggregateError);
    expect(performance.now() - startedAt).toBeLessThan(1_500);
    const response = await fetch(`http://127.0.0.1:${config.port}/health`);
    expect(response.status).toBe(200);
  } finally {
    const result = await first.stop();
    expect(result.outcome).toBe('clean');
  }
  const rebound = await startBroker(config);
  expect((await rebound.stop()).outcome).toBe('clean');
});
