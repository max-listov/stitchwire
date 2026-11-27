import { expect, test } from 'bun:test';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { freePort } from './support.ts';

test('call, service, stream and publish report the same no-connected-lane cause', async () => {
  const port = freePort();
  const agent = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'caller',
      brokers: [
        {
          id: 'absent',
          url: `http://127.0.0.1:${port}`,
          token: 'absent-multi-plane-token'.padEnd(40, 'x'),
          reconnect: { minDelayMs: 100, maxDelayMs: 100 },
        },
      ],
      defaultTimeoutMs: 1000,
      events: { publish: ['test.telemetry'] },
      admission: { publishAckTimeoutMs: 100 },
    }),
  );
  const stream = async () => {
    const frames = [];
    for await (const frame of agent.openStream({
      to: 'target',
      profile: 'echo',
      args: [],
      stdin: null,
      cursor: null,
      timeoutMs: 1000,
    }))
      frames.push(frame);
    return frames.at(-1);
  };
  try {
    const [call, service, terminal, publish] = await Promise.all([
      agent.call({ to: 'target', argv: ['echo'], stdin: null, timeoutMs: 1000 }),
      agent.invokeService({
        to: 'target',
        service: 'test.echo',
        revision: '1',
        operation: 'read',
        payload: '{}',
        timeoutMs: 1000,
      }),
      stream(),
      agent.publishEvent({
        topic: 'test.telemetry',
        bootId: '11111111-1111-4111-8111-111111111111',
        seq: 0,
        observedAt: null,
        cursor: null,
        data: '{}',
      }),
    ]);
    expect(call.transportCause).toBe('no-connected-lane');
    expect(service.status === 'failure' ? service.transportCause : null).toBe('no-connected-lane');
    expect(terminal && 'failure' in terminal ? terminal.transportCause : null).toBe('no-connected-lane');
    expect(publish.transportCause).toBe('no-connected-lane');
  } finally {
    await agent.stop();
  }
});
