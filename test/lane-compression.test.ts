import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { bindUnixSocket } from 'stitchkit/files';
import { createWireClient } from '../packages/client/src/index.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { LaneVolumeSchema, laneVolumeRows } from '../packages/runtime/src/transport/lane-volume.ts';
import { observationPayload } from './fixtures/lane-payload.ts';
import type { ServiceGrant } from '../packages/contracts/src/service/policy-schema.ts';
import { brokerConfig, freePort, waitConnected } from './support.ts';

test('SDK unary and events cross both compressed broker legs with measured bytes and unchanged bounds', async () => {
  const root = await mkdtemp('/tmp/wire-compression-');
  const payload = observationPayload();
  let response = payload;
  const socketPath = `${root}/owner.sock`;
  const descriptorPath = `${root}/descriptor.json`;
  const limits = { requestBytes: 1024, responseBytes: Buffer.byteLength(payload), timeoutMs: 5000 };
  const grant: ServiceGrant = {
    caller: 'reader',
    target: 'worker',
    service: 'example.data',
    scope: { kind: 'service-read' },
  };
  await writeFile(
    descriptorPath,
    JSON.stringify({
      service: 'example.data',
      revision: '1',
      maxInflight: 2,
      operations: [{ id: 'read', path: '/read', effect: 'read', limits, response: { kind: 'unary' } }],
    }),
  );
  const owner = bindUnixSocket({ path: socketPath, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      fetch: () =>
        new Response(response, {
          headers: { 'content-type': 'application/json' },
        }),
    }),
  );
  const token = 'compression-test'.padEnd(40, 'x');
  const broker = await startBroker(
    brokerConfig(
      { reader: token, worker: token },
      {
        port: freePort(),
        serviceGrants: [grant],
        auditPath: `${root}/audit.jsonl`,
        capabilities: {
          worker: [{ operation: 'publish', targets: ['worker'] }],
          reader: [{ operation: 'subscribe', targets: ['worker'] }],
        },
        topics: { 'example.events': { producer: 'worker', subscribers: ['reader'], delivery: 'ordered' } },
      },
    ),
  );
  const brokers = [{ id: 'test', url: `http://127.0.0.1:${broker.port}`, token }];
  const worker = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers,
      agentSocket: `${root}/worker.sock`,
      events: { publish: ['example.events'] },
      services: {
        grants: [grant],
        bindings: [
          {
            service: 'example.data',
            descriptorPath,
            socketPath,
            endpointPath: '/invoke',
            maxInflight: 2,
            limits,
          },
        ],
      },
    }),
  );
  const reader = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'reader',
      brokers,
      agentSocket: `${root}/reader.sock`,
      events: { subscribe: ['example.events'] },
    }),
  );
  using client = createWireClient({ socketPath: `${root}/reader.sock` });
  using producer = createWireClient({ socketPath: `${root}/worker.sock` });
  try {
    await waitConnected(reader, worker);
    const call = {
      to: 'worker',
      service: 'example.data',
      revision: '1',
      operation: 'read',
      payload: '{}',
      timeoutMs: 5000,
    };
    expect((await client.invokeService(call)).outcome).toMatchObject({ status: 'response', payload });
    response = `${payload} `;
    expect((await client.invokeService(call)).outcome).toMatchObject({
      status: 'failure',
      code: 'invalid-response',
    });
    response = payload;
    expect((await client.invokeService(call)).outcome).toMatchObject({ status: 'response', payload });
    expect((await client.invokeService({ ...call, operation: 'absent' })).outcome).toMatchObject({
      status: 'failure',
    });

    const feed = client.subscribe({ topic: 'example.events', lifecycle: true });
    for (;;) {
      const ready = await feed.next();
      if (ready.done || ready.value.kind !== 'subscription')
        throw new Error('expected subscription lifecycle');
      if (ready.value.frame.subscriptionState === 'ready') break;
    }
    const secondFeed = client.subscribe({ topic: 'example.events', lifecycle: true });
    expect(await secondFeed.next()).toMatchObject({
      value: { kind: 'subscription', frame: { subscriptionState: 'ready' } },
    });
    expect((await client.status()).events.activeSubscriptions).toBe(2);
    expect((await client.status()).lanes[0]?.eventSubscriptions.activeSubscriptions).toBe(1);
    const bootId = crypto.randomUUID();
    for (let seq = 0; seq < 12; seq++) {
      const data = observationPayload(2400);
      expect((await producer.publish({ topic: 'example.events', bootId, seq, data })).ok).toBe(true);
      let item = await feed.next();
      while (!item.done && item.value.kind === 'subscription') item = await feed.next();
      expect(item.done).toBe(false);
      if (item.done || item.value.kind !== 'event') throw new Error('expected event');
      expect(item.value.frame.seq).toBe(seq);
      expect(Buffer.from(item.value.data).toString()).toBe(data);
      const second = await secondFeed.next();
      expect(second).toMatchObject({ value: { kind: 'event', frame: { seq } } });
      if (second.done || second.value.kind !== 'event') throw new Error('expected second event');
      expect(second.value.frame.subscriptionId).not.toBe(item.value.frame.subscriptionId);
      expect(Buffer.from(second.value.data).toString()).toBe(data);
    }
    await feed.return();
    await secondFeed.return();
    await reader.stop();
    await worker.stop();
    await broker.stop();
    const rows = (await readFile(`${root}/audit.jsonl`, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => z.object({ event: z.unknown() }).parse(JSON.parse(line)).event)
      .flatMap((event) => {
        const parsed = LaneVolumeSchema.safeParse(event);
        return parsed.success ? laneVolumeRows(parsed.data) : [];
      });
    const outputs = rows.filter((row) => row.event === 'service:result' && row.direction === 'out');
    const inputs = rows.filter((row) => row.event === 'service:result' && row.direction === 'in');
    expect(outputs.length).toBeGreaterThan(0);
    expect(inputs.length).toBeGreaterThan(0);
    for (const group of [outputs, inputs]) {
      expect(group.every((row) => row.service === 'example.data')).toBe(true);
      expect(group.reduce((n, row) => n + row.compressedFrames, 0)).toBe(2);
      expect(group.reduce((n, row) => n + row.encodedBytes, 0)).toBeLessThan(2 * 45000);
    }
    for (const [event, direction] of [
      ['event:publish', 'in'],
      ['event:event', 'out'],
    ]) {
      const events = rows.filter((row) => row.event === event && row.direction === direction);
      expect(events.reduce((n, row) => n + row.frames, 0)).toBe(12);
      expect(events.every((row) => row.topic === 'example.events')).toBe(true);
      expect(events.reduce((n, row) => n + row.encodedBytes, 0)).toBeLessThan((12 * 2400) / 3);
    }
  } finally {
    await reader.stop();
    await worker.stop();
    await broker.stop();
    owner.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
