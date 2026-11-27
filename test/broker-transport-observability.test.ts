import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EVENT_LOOP_DELAY_WINDOW_MS,
  EventLoopDelayMonitor,
} from '../packages/runtime/src/broker/event-loop-delay.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { brokerConfig, brokerHealth, freePort, until, waitConnected } from './support.ts';

test('event-loop delay is unknown before sampling and preserves the observed maximum', () => {
  const monitor = new EventLoopDelayMonitor();
  expect(monitor.snapshot()).toEqual({
    state: 'unknown',
    sampledAt: null,
    lastMs: null,
    maxMs: null,
    windowMs: EVENT_LOOP_DELAY_WINDOW_MS,
  });
  expect(monitor.observe(100, 137, '2026-09-04T05:00:00.000Z')).toEqual({
    state: 'measured',
    sampledAt: '2026-09-04T05:00:00.000Z',
    lastMs: 37,
    maxMs: 37,
    windowMs: EVENT_LOOP_DELAY_WINDOW_MS,
  });
  expect(monitor.observe(200, 205, '2026-09-04T05:00:01.000Z')).toMatchObject({
    state: 'measured',
    lastMs: 5,
    maxMs: 37,
  });
});

test('an old stall leaves the maximum once it is older than the window', () => {
  // Measured on a live broker: `maxMs=257.9` beside `lastMs=1.3` a day after the stall, on every
  // check, because the maximum reached back to the process start.
  const monitor = new EventLoopDelayMonitor();
  const stallAt = 1_000_000;
  expect(monitor.observe(stallAt, stallAt + 258, '2026-09-14T09:00:00.000Z')).toMatchObject({ maxMs: 258 });
  const justInside = stallAt + EVENT_LOOP_DELAY_WINDOW_MS - 20_000;
  expect(monitor.observe(justInside, justInside + 1, '2026-09-14T09:04:40.000Z')).toMatchObject({
    maxMs: 258,
  });
  const pastWindow = stallAt + EVENT_LOOP_DELAY_WINDOW_MS + 20_000;
  expect(monitor.observe(pastWindow, pastWindow + 1, '2026-09-14T09:05:20.000Z')).toMatchObject({
    lastMs: 1,
    maxMs: 1,
  });
});

test('broker health and canonical audit identify the latest disconnect and measured loop delay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-broker-transport-'));
  const auditPath = join(root, 'audit.jsonl');
  const port = freePort();
  const token = 'broker-transport-token'.padEnd(40, 'x');
  const broker = await startBroker(brokerConfig({ worker: token }, { port, auditPath }));
  const agent = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token }],
    }),
  );
  let agentStopped = false;
  try {
    await waitConnected(agent);
    // The loop delay is reported once the broker's sampler has taken a measurement.
    expect(
      await until(async () => (await brokerHealth(port)).transport.eventLoopDelay.state === 'measured'),
    ).toBe(true);
    await agent.stop();
    agentStopped = true;
    // The broker learns of the disconnect from its own socket, after the agent's stop returns.
    expect(await until(async () => (await brokerHealth(port)).transport.lastDisconnect !== null)).toBe(true);
    const health = await brokerHealth(port);
    expect(health.transport).toMatchObject({
      broker: `127.0.0.1:${port}`,
      lastDisconnect: { nodeId: 'worker', reason: 'client namespace disconnect' },
      eventLoopDelay: { state: 'measured' },
    });
  } finally {
    if (!agentStopped) await agent.stop();
    await broker.stop();
  }
  const records = (await Bun.file(auditPath).text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).event)
    .filter((record) => record.kind === 'disconnect' && record.nodeId === 'worker');
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    broker: `127.0.0.1:${port}`,
    reason: 'client namespace disconnect',
  });
  expect(new Date(records[0].ts).toISOString()).toBe(records[0].ts);
});
