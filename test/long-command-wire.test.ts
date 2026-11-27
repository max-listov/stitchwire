import { expect, test } from 'bun:test';
import { MAX_COMMAND_TIMEOUT_MS } from '../packages/contracts/src/protocol/bounds.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { temporaryFile } from './temporary.ts';
import { brokerConfig, freePort, waitConnected } from './support.ts';

test('long fixed command crosses actual broker and retains independent grant/profile gates', async () => {
  const callerToken = 'synthetic-caller-'.repeat(3),
    workerToken = 'synthetic-worker-'.repeat(3);
  const broker = await startBroker(
    brokerConfig(
      { caller: callerToken, worker: workerToken },
      {
        port: freePort(),
        commandGrants: [{ caller: 'caller', targets: ['worker'], command: 'transaction' }],
        auditPath: temporaryFile('long-command-audit'),
      },
    ),
  );
  const endpoint = (token: string) => [{ id: 'primary', url: `http://127.0.0.1:${broker.port}`, token }];
  const caller = createAgent(NodeConfigSchema.parse({ nodeId: 'caller', brokers: endpoint(callerToken) }));
  const worker = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers: endpoint(workerToken),
      allow: {
        transaction: {
          bin: '/usr/bin/printf',
          argv: ['{"ok":true}'],
          output: { mode: 'json' },
          timeoutMs: MAX_COMMAND_TIMEOUT_MS,
          cancellation: { mode: 'cooperative', graceMs: 1000 },
        },
      },
    }),
  );
  try {
    await waitConnected(caller, worker);
    const good = await caller.call({
      to: 'worker',
      argv: ['transaction'],
      stdin: null,
      timeoutMs: MAX_COMMAND_TIMEOUT_MS,
    });
    expect(good).toMatchObject({ failure: 'none', code: 0, stdout: '{"ok":true}' });
    const extra = await caller.call({
      to: 'worker',
      argv: ['transaction', '--path', '/tmp/example'],
      stdin: null,
    });
    expect(extra).toMatchObject({ from: 'worker', failure: 'denied', refusal: 'request', stdout: '' });
    const input = await caller.call({ to: 'worker', argv: ['transaction'], stdin: 'unexpected' });
    expect(input).toMatchObject({ from: 'worker', failure: 'denied', refusal: 'request' });
    const wrongCaller = await worker.call({ to: 'caller', argv: ['transaction'], stdin: null });
    expect(wrongCaller).toMatchObject({ from: 'broker', failure: 'denied', refusal: 'policy' });
    const shell = await caller.call({ to: 'worker', argv: ['sh', '-c', 'id'], stdin: null });
    expect(shell).toMatchObject({ from: 'broker', failure: 'denied', refusal: 'policy' });
  } finally {
    await caller.stop();
    await worker.stop();
    await broker.stop();
  }
});
