import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { brokerConfig, freePort, until } from './support.ts';

const event = (seq: number) => ({
  topic: 'test.telemetry',
  bootId: '11111111-1111-4111-8111-111111111111',
  seq,
  observedAt: null,
  cursor: null,
  data: '{"ok":true}',
});

test('publish waits inside a bounded slot and dispatches once when its lane reconnects', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-publish-reconnect-'));
  const port = freePort();
  const token = 'publish-reconnect-token'.padEnd(40, 'x');
  const agent = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'publisher',
      brokers: [
        {
          id: 'late',
          url: `http://127.0.0.1:${port}`,
          token,
          reconnect: { minDelayMs: 100, maxDelayMs: 100 },
        },
      ],
      events: { publish: ['test.telemetry'] },
      admission: { maxPendingPublishes: 1, publishAckTimeoutMs: 1000 },
    }),
  );
  const pending = agent.publishEvent(event(0));
  // The publish is held in its bounded slot while no lane is up; the broker starts only after that.
  expect(await until(async () => (await agent.status()).events.pendingPublishes === 1)).toBe(true);
  const auditPath = join(root, 'audit.jsonl');
  const broker = await startBroker(
    brokerConfig(
      { publisher: token, sink: 'sink-token'.padEnd(40, 'x') },
      {
        port,
        capabilities: { publisher: [{ operation: 'publish', targets: ['publisher'] }] },
        topics: {
          'test.telemetry': { producer: 'publisher', subscribers: ['sink'], delivery: 'ordered' },
        },
        auditPath,
      },
    ),
  );
  try {
    expect(await pending).toMatchObject({ ok: true });
    const published = async () =>
      (await Bun.file(auditPath).text())
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).event)
        .filter((record) => record.kind === 'event-publish' && record.seq === 0);
    // The audit trail is written behind the acknowledgement; wait for its row, then count it.
    expect(await until(async () => (await published()).length >= 1)).toBe(true);
    expect(await published()).toHaveLength(1);
  } finally {
    await agent.stop();
    await broker.stop();
  }
});

test('publish grace is finite, typed and releases its bounded wait slot', async () => {
  const port = freePort();
  const agent = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'publisher',
      brokers: [
        {
          id: 'absent',
          url: `http://127.0.0.1:${port}`,
          token: 'absent-broker-token'.padEnd(40, 'x'),
          reconnect: { minDelayMs: 100, maxDelayMs: 100 },
        },
      ],
      events: { publish: ['test.telemetry'] },
      admission: { maxPendingPublishes: 1, publishAckTimeoutMs: 100 },
    }),
  );
  try {
    const started = performance.now();
    const first = agent.publishEvent(event(0));
    expect(await agent.publishEvent(event(1))).toMatchObject({ refusal: 'capacity' });
    expect(await first).toMatchObject({
      ok: false,
      failure: 'transport',
      transportCause: 'no-connected-lane',
    });
    expect(performance.now() - started).toBeLessThan(500);
    expect(await agent.publishEvent(event(2))).toMatchObject({
      refusal: 'none',
      transportCause: 'no-connected-lane',
    });
  } finally {
    await agent.stop();
  }
});
