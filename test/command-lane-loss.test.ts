import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { stillRunning } from '../packages/runtime/src/node/process-state.ts';
import { relay } from './relay.ts';
import { brokerConfig, freePort, until, waitConnected } from './support.ts';

/*
 * A command is stopped on its target when the target's lane is lost: the broker has already told the
 * caller `lane-lost-after-dispatch`, so a command left running would finish its effects after the
 * caller was told the call did not complete, and its answer would be refused.
 */

const fixture = join(import.meta.dir, 'fixtures/cooperative-command.ts');
const markerSchema = z.strictObject({ pid: z.number().int(), childPid: z.number().int() });

test('a command running on a target whose lane is lost is stopped, and the caller is told the lane was lost', async () => {
  const port = freePort();
  const root = mkdtempSync(join(tmpdir(), 'wire-command-lane-loss-'));
  const marker = join(root, 'ready.json');
  const callerToken = 'caller-lane-loss-token'.padEnd(40, 'x');
  const workerToken = 'worker-lane-loss-token'.padEnd(40, 'x');
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
  const path = await relay(port);
  const caller = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'caller',
      brokers: [{ id: 'primary', url, token: callerToken }],
      agentSocket: join(root, 'caller.sock'),
    }),
  );
  // This owner ignores the stop request, so only the profile's own grace (then the kill) ends it:
  // a command left running by the lane loss would stay until its 60 s deadline.
  const worker = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${path.port}`, token: workerToken }],
      agentSocket: join(root, 'worker.sock'),
      allow: {
        transaction: {
          bin: process.execPath,
          argv: [fixture, 'ignore', marker],
          timeoutMs: 60_000,
          cancellation: { mode: 'cooperative', graceMs: 300 },
          concurrency: 1,
        },
      },
    }),
  );
  try {
    await waitConnected(caller, worker);
    const running = caller.call({ to: 'worker', argv: ['transaction'], stdin: null, timeoutMs: 30_000 });
    const readMarker = (): z.infer<typeof markerSchema> | undefined => {
      try {
        return markerSchema.parse(JSON.parse(readFileSync(marker, 'utf8')));
      } catch {
        return undefined;
      }
    };
    expect(await until(() => readMarker() !== undefined)).toBe(true);
    const owner = readMarker();
    if (owner === undefined) throw new Error('fixture did not start');
    expect(stillRunning(owner.pid)).toBe(true);

    path.cut();

    expect(await running).toMatchObject({ failure: 'transport', transportCause: 'lane-lost-after-dispatch' });
    expect(await until(() => !stillRunning(owner.pid) && !stillRunning(owner.childPid))).toBe(true);
  } finally {
    await caller.stop();
    await worker.stop();
    path.close();
    await broker.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
