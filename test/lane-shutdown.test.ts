import { expect, test } from 'bun:test';
import type { Result } from '../packages/contracts/src/protocol/rpc.ts';
import {
  drainLaneRpc,
  type PendingCall,
  type RunningCommand,
} from '../packages/runtime/src/node/lane-rpc.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { brokerConfig, freePort, until, waitConnected } from './support.ts';

test('lane drain settles every pending call and waits for running work to observe cancellation', async () => {
  const id = crypto.randomUUID();
  const result = Promise.withResolvers<Result>();
  const pending = new Map<string, PendingCall>([
    [id, { settle: result.resolve, timer: setTimeout(() => {}, 60_000) }],
  ]);
  const withdrawal = new AbortController();
  let stopped = false;
  const runningTask = new Promise<void>((resolve) => {
    withdrawal.signal.addEventListener(
      'abort',
      () => {
        stopped = true;
        resolve();
      },
      { once: true },
    );
  });

  const command: RunningCommand = { withdrawal, force: new AbortController() };
  await drainLaneRpc(pending, new Map([['command', command]]), new Set([runningTask]));
  // Work that observed the withdrawal in time is never forced.
  expect(command.force.signal.aborted).toBe(false);

  expect(await result.promise).toMatchObject({ id, failure: 'cancelled', transportCause: null });
  expect(pending.size).toBe(0);
  expect(stopped).toBe(true);
});

test('application stop aborts a running incoming command before the lane disconnects', async () => {
  const port = freePort();
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-lane-shutdown-'));
  const callerToken = 'caller-shutdown-token'.padEnd(40, 'x');
  const workerToken = 'worker-shutdown-token'.padEnd(40, 'x');
  const broker = await startBroker(
    brokerConfig(
      { caller: callerToken, worker: workerToken },
      {
        port,
        capabilities: { caller: [{ operation: 'peer', targets: ['worker'] }] },
        commandGrants: [{ caller: 'caller', targets: ['worker'], command: 'wait' }],
      },
    ),
  );
  const brokers = [{ id: 'primary', url: `http://127.0.0.1:${port}` }];
  const caller = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'caller',
      brokers: [{ ...brokers[0], token: callerToken }],
      agentSocket: join(root, 'caller.sock'),
    }),
  );
  // Unique per run: a fixed marker let a parallel run of this file see the other's process alive.
  const marker = String(100_000 + Math.floor(Math.random() * 800_000));
  const worker = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers: [{ ...brokers[0], token: workerToken }],
      agentSocket: join(root, 'worker.sock'),
      allow: {
        wait: { bin: '/bin/sleep', argv: [marker], timeoutMs: 900_000 },
      },
    }),
  );
  const alive = async (): Promise<boolean> => {
    const child = Bun.spawn(['pgrep', '-f', `sleep ${marker}`], { stdout: 'pipe', stderr: 'ignore' });
    const output = await new Response(child.stdout).text();
    await child.exited;
    return output.trim() !== '';
  };
  try {
    await waitConnected(caller, worker);
    const running = caller.call({ to: 'worker', argv: ['wait'], stdin: null, timeoutMs: 30_000 });
    expect(await until(alive)).toBe(true);
    await worker.stop();
    expect(await running).toMatchObject({ failure: 'cancelled', transportCause: null });
    expect(await alive()).toBe(false);
  } finally {
    await caller.stop();
    await worker.stop();
    await broker.stop();
  }
});
