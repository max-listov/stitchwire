import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { stillRunning } from '../packages/runtime/src/node/process-state.ts';
import { brokerConfig, freePort, until, waitConnected } from './support.ts';

/*
 * Cooperative cancellation through a broker, as a caller meets it (ADR 0013): the caller's answer
 * is settled at its own withdrawal, the target keeps the profile's single slot while the owner
 * finishes, and a stopping agent does not wait out the owner's grace.
 */

const fixture = join(import.meta.dir, 'fixtures/cooperative-command.ts');
const markerSchema = z.strictObject({ pid: z.number().int(), childPid: z.number().int() });

async function fleet(mode: 'owner' | 'ignore', graceMs: number) {
  const port = freePort();
  const root = mkdtempSync(join(tmpdir(), 'wire-cooperative-broker-'));
  const marker = join(root, 'ready.json');
  const callerToken = 'caller-cooperative-token'.padEnd(40, 'x');
  const workerToken = 'worker-cooperative-token'.padEnd(40, 'x');
  const broker = await startBroker(
    brokerConfig(
      { caller: callerToken, worker: workerToken },
      {
        port,
        capabilities: { caller: [{ operation: 'peer', targets: ['worker'] }] },
        commandGrants: [{ caller: 'caller', targets: ['worker'], command: 'transaction' }],
      },
    ),
  );
  const url = `http://127.0.0.1:${port}`;
  const caller = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'caller',
      brokers: [{ id: 'primary', url, token: callerToken }],
      agentSocket: join(root, 'caller.sock'),
    }),
  );
  const worker = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers: [{ id: 'primary', url, token: workerToken }],
      agentSocket: join(root, 'worker.sock'),
      allow: {
        transaction: {
          bin: process.execPath,
          argv: [fixture, mode, marker],
          timeoutMs: 60_000,
          cancellation: { mode: 'cooperative', graceMs },
          concurrency: 1,
        },
      },
    }),
  );
  await waitConnected(caller, worker);
  const readMarker = (): z.infer<typeof markerSchema> | undefined => {
    try {
      return markerSchema.parse(JSON.parse(readFileSync(marker, 'utf8')));
    } catch {
      return undefined;
    }
  };
  const ready = async () => {
    await until(() => readMarker() !== undefined);
    const parsed = readMarker();
    if (parsed === undefined) throw new Error('fixture did not start');
    return parsed;
  };
  const stop = async () => {
    await caller.stop();
    await worker.stop();
    await broker.stop();
    rmSync(root, { recursive: true, force: true });
  };
  return { caller, worker, ready, stop };
}

const call = { to: 'worker', argv: ['transaction'], stdin: null, timeoutMs: 30_000 };

test('a withdrawn caller is answered at once while the target keeps the slot until the owner finishes', async () => {
  const { caller, ready, stop } = await fleet('owner', 10_000);
  try {
    const withdrawal = new AbortController();
    const first = caller.call(call, withdrawal.signal);
    const owner = await ready();
    withdrawal.abort();
    expect(await first).toMatchObject({ failure: 'cancelled' });
    // The owner is finishing its child transaction (1200 ms); the profile's single slot is still
    // held on the target, so the broker admits and the target refuses.
    expect(stillRunning(owner.childPid)).toBe(true);
    expect(await caller.call(call)).toMatchObject({ refusal: 'capacity' });
    expect(await until(() => !stillRunning(owner.pid) && !stillRunning(owner.childPid))).toBe(true);
  } finally {
    await stop();
  }
});

test('a stopping agent ends a long cooperative grace instead of outliving it', async () => {
  // An owner that ignores SIGTERM never finishes on its own; only the drain's kill ends it.
  const { caller, worker, ready, stop } = await fleet('ignore', 600_000);
  try {
    const running = caller.call(call);
    const owner = await ready();
    // A ten-minute grace waited out would trip the suite's hang bound; drain must force it.
    await worker.stop();
    expect(await until(() => !stillRunning(owner.pid) && !stillRunning(owner.childPid))).toBe(true);
    expect(await running).toMatchObject({ failure: 'cancelled' });
  } finally {
    await stop();
  }
});

test('a caller that leaves mid-command makes the broker cancel it on the target', async () => {
  const { caller, ready, stop } = await fleet('owner', 10_000);
  try {
    void caller.call(call).catch(() => undefined);
    const owner = await ready();
    // The caller's connection ends with the command running; nothing else asks for a cancel, so only
    // the broker's disconnect handling can reach the target before the profile's 60 s timeout.
    await caller.stop();
    expect(await until(() => !stillRunning(owner.pid) && !stillRunning(owner.childPid))).toBe(true);
  } finally {
    await stop();
  }
});
