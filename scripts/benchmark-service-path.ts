import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { createWireClient } from '../packages/client/src/index.ts';
import { bindUnixSocket } from 'stitchkit/files';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { z } from 'zod';
import type { ServiceGrant } from '../packages/contracts/src/service/policy-schema.ts';
import { brokerConfig, freePort, waitConnected } from '../test/support.ts';
import { median } from './bench-stats.ts';

/** All participants run locally; CPU includes SDK, two agents, broker and synthetic owner. */
const callsPerRound = z.coerce
  .number()
  .int()
  .min(100)
  .max(10000)
  .parse(process.argv[2] ?? 1000);
const root = await mkdtemp(join(tmpdir(), 'wire-service-path-bench-'));
const payload = JSON.stringify({ value: 'x'.repeat(2400) });
const descriptorPath = join(root, 'descriptor.json');
const ownerPath = join(root, 'owner.sock');
const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 };
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
    maxInflight: 4,
    operations: [{ id: 'read', path: '/read', effect: 'read', limits, response: { kind: 'unary' } }],
  }),
);
const owner = bindUnixSocket({ path: ownerPath, mode: 0o600 }, (unix) =>
  Bun.serve({ unix, fetch: () => Response.json({ value: 'x'.repeat(2400) }) }),
);
const port = freePort();
const token = 't'.repeat(40);
const broker = await startBroker(
  brokerConfig(
    { reader: token, worker: token },
    { port, serviceGrants: [grant], auditPath: join(root, 'audit.jsonl') },
  ),
);
const brokers = [{ id: 'primary', url: `http://127.0.0.1:${port}`, token }];
const worker = await startAgent(
  NodeConfigSchema.parse({
    nodeId: 'worker',
    brokers,
    agentSocket: join(root, 'worker.sock'),
    services: {
      grants: [grant],
      bindings: [
        {
          service: 'example.data',
          descriptorPath,
          socketPath: ownerPath,
          endpointPath: '/invoke',
          maxInflight: 4,
          limits,
        },
      ],
    },
  }),
);
const readerPath = join(root, 'reader.sock');
const reader = await startAgent(
  NodeConfigSchema.parse({ nodeId: 'reader', brokers, agentSocket: readerPath }),
);
try {
  await waitConnected(worker, reader);
  using client = createWireClient({ socketPath: readerPath });
  const call = {
    to: 'worker',
    service: 'example.data',
    revision: '1',
    operation: 'read',
    payload: '{}',
    timeoutMs: 5000,
  };
  const invoke = async () => {
    const result = await client.invokeService(call);
    assert.equal(result.outcome.status, 'response');
    if (result.outcome.status !== 'response') throw new Error('request refused');
    assert.equal(result.outcome.payload, payload);
  };
  const refused = await client.invokeService({ ...call, service: 'example.denied' });
  assert.equal(refused.outcome.status, 'failure');
  if (refused.outcome.status !== 'failure') throw new Error('denied call was dispatched');
  assert.equal(refused.outcome.code, 'denied');
  for (let i = 0; i < 1000; i++) await invoke();
  const samples = [];
  for (let round = 0; round < 7; round++) {
    const cpu = process.cpuUsage();
    const times = [];
    for (let i = 0; i < callsPerRound; i++) {
      const start = performance.now();
      await invoke();
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const spent = process.cpuUsage(cpu);
    samples.push({
      cpuUsPerCall: (spent.user + spent.system) / callsPerRound,
      p50Ms: times[Math.ceil(callsPerRound * 0.5) - 1],
      p95Ms: times[Math.ceil(callsPerRound * 0.95) - 1],
      p99Ms: times[Math.ceil(callsPerRound * 0.99) - 1],
    });
  }
  console.log(
    JSON.stringify({
      benchmark: 'sdk-unix-agent-broker-agent-owner',
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      concurrency: 1,
      payloadBytes: Buffer.byteLength(payload),
      warmup: 1000,
      rounds: 7,
      callsPerRound,
      samples,
      medianCpuUsPerCall: median(samples.map((s) => s.cpuUsPerCall)),
      p50Ms: median(samples.map((s) => s.p50Ms ?? Number.NaN)),
      p95Ms: median(samples.map((s) => s.p95Ms ?? Number.NaN)),
      p99Ms: median(samples.map((s) => s.p99Ms ?? Number.NaN)),
      delivered: 1000 + 7 * callsPerRound,
      denied: 1,
      caveat: 'local synthetic sequential service workload; not fleet latency or idle CPU',
    }),
  );
} finally {
  await reader.stop();
  await worker.stop();
  await broker.stop();
  owner.stop(true);
  await rm(root, { recursive: true, force: true });
}
