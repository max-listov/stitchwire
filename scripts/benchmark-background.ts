import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { ServiceDeclarationSchema } from '../packages/contracts/src/service/declaration.ts';
import { TopicDescriptorSchema } from '../packages/contracts/src/protocol/topic.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { generateSigningKey } from '../packages/runtime/src/fleet/signature.ts';
import { buildBundle } from '../packages/runtime/src/fleet/bundle.ts';
import { applyNodeTables, applyBrokerTables, nodeTables } from '../packages/runtime/src/fleet/projection.ts';
import { FleetFollower } from '../packages/runtime/src/node/fleet-follower.ts';
import { FleetKeeper } from '../packages/runtime/src/broker/fleet-keeper.ts';
import { ServiceDeclarer } from '../packages/runtime/src/node/service-declarations.ts';
import { TopicDeclarer } from '../packages/runtime/src/node/topic-declarations.ts';
import { LaneVolumeMeter } from '../packages/runtime/src/transport/lane-volume.ts';
import { laneCodec } from '../packages/runtime/src/transport/lane-codec.ts';
import { createAudit } from '../packages/runtime/src/broker/audit.ts';
import { EventLoopDelayMonitor } from '../packages/runtime/src/broker/event-loop-delay.ts';
import { median } from './bench-stats.ts';

/** The same harness runs in an isolated baseline checkout and the review tree. No live services. */
const root = mkdtempSync(join(tmpdir(), 'wire-background-bench-'));
const sampleSchema = z.object({
  frames: z.number().optional(),
  rows: z.array(z.object({ frames: z.number() })).optional(),
});
function frames(value: unknown): number {
  const parsed = sampleSchema.parse(value);
  return parsed.frames ?? parsed.rows?.reduce((sum, row) => sum + row.frames, 0) ?? 0;
}

async function measure(name: string, iterations: number, run: () => Promise<void> | void) {
  for (let i = 0; i < 100; i++) await run();
  const samples = [];
  for (let round = 0; round < 7; round++) {
    const started = performance.now();
    const cpu = process.cpuUsage();
    for (let i = 0; i < iterations; i++) await run();
    const spent = process.cpuUsage(cpu);
    samples.push({
      wallUs: ((performance.now() - started) * 1000) / iterations,
      cpuUs: (spent.user + spent.system) / iterations,
    });
  }
  console.log(
    JSON.stringify({
      benchmark: name,
      iterations,
      samples,
      medianWallUs: median(samples.map((s) => s.wallUs)),
      medianCpuUs: median(samples.map((s) => s.cpuUs)),
    }),
  );
}

try {
  console.log(
    JSON.stringify({
      environment: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model,
        warmup: 100,
        rounds: 7,
        memory: process.memoryUsage().rss,
      },
    }),
  );
  const signer = generateSigningKey();
  const members = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`node${i}`, { copy: 'full' }]));
  const manifest = FleetManifestSchema.parse({
    version: 1,
    members,
    access: Array.from({ length: 11 }, (_, i) => ({
      from: 'node0',
      to: `node${i + 1}`,
      services: { 'example.metrics': ['service-read', 'metrics.refresh'] },
    })),
    serviceNamespaces: Object.fromEntries(Object.keys(members).map((node) => [node, ['example.']])),
  });
  const copy = join(root, 'bundle.json');
  writeFileSync(
    copy,
    JSON.stringify(
      buildBundle({
        manifest,
        serial: 1,
        issuedAt: '2026-01-01T00:00:00.000Z',
        keyId: 'benchmark',
        privateKeyPem: signer.privateKeyPem,
      }),
    ),
  );
  const fleet = { copy, trust: [{ id: 'benchmark', publicKey: signer.publicKey }] };
  const node = NodeConfigSchema.parse(
    applyNodeTables(
      {
        nodeId: 'node1',
        brokers: [{ id: 'primary', url: 'http://127.0.0.1:1', token: 't'.repeat(40) }],
        fleet,
      },
      nodeTables(manifest, 'node1'),
    ),
  );
  const nodePath = join(root, 'node.json');
  writeFileSync(nodePath, JSON.stringify(node));
  const broker = BrokerConfigSchema.parse(
    applyBrokerTables(
      { nodes: Object.keys(members).map((id) => ({ id, tokenSha256s: ['a'.repeat(64)] })), fleet },
      manifest,
    ),
  );
  const brokerPath = join(root, 'broker.json');
  writeFileSync(brokerPath, JSON.stringify(broker));
  const follower = new FleetFollower('node1', node.fleet, node, nodePath, undefined);
  const keeper = new FleetKeeper(
    broker.fleet,
    broker,
    brokerPath,
    undefined,
    () => {},
    () => {},
  );
  await measure('fleet-agent-poll', 3000, () => {
    follower.start();
    follower.stop();
  });
  if (follower.snapshot().config !== 'aligned') throw new Error('agent poll did not reconcile');
  await measure('fleet-broker-poll', 3000, () => {
    keeper.start();
    keeper.stop();
  });
  if (keeper.health().config !== 'aligned') throw new Error('broker poll did not reconcile');

  const declarations = Array.from({ length: 6 }, (_, i) => {
    const path = join(root, `service${i}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        ServiceDeclarationSchema.parse({
          binding: {
            service: `example.service${i}`,
            descriptorPath: join(root, `descriptor${i}.json`),
            socketPath: join(root, `service${i}.sock`),
            endpointPath: '/invoke',
            maxInflight: 4,
            limits: { requestBytes: 1024, responseBytes: 65536, timeoutMs: 2000 },
          },
          callers: Array.from({ length: 16 }, (_, n) => ({
            caller: `reader${n}`,
            scope: { kind: 'service-read' },
          })),
        }),
      ),
    );
    return path;
  });
  const topics = Array.from({ length: 2 }, (_, i) => {
    const path = join(root, `topics${i}.json`);
    writeFileSync(
      path,
      JSON.stringify(
        TopicDescriptorSchema.parse({
          topics: Object.fromEntries(
            Array.from({ length: 16 }, (_, n) => [`example.topic${i}.${n}`, { delivery: 'ordered' }]),
          ),
        }),
      ),
    );
    return path;
  });
  const services = new ServiceDeclarer(
    'node1',
    { bindings: [], grants: [], namespaces: ['example.'], descriptors: declarations },
    () => {},
  );
  const events = new TopicDeclarer('node1', { descriptors: topics, namespaces: { publish: ['example.'] } });
  await measure('declarations-6-services-32-topics', 1000, async () => {
    await services.refresh();
    await events.refresh();
  });
  if (
    services.snapshot().descriptors.some((item) => item.state !== 'loaded') ||
    events.snapshot().descriptors.some((item) => item.state !== 'loaded')
  )
    throw new Error('invalid benchmark declarations');

  const encoder = new laneCodec.Encoder();
  const packets = Array.from(
    { length: 24 },
    (_, i) =>
      encoder.encode({
        type: 2,
        nsp: '/',
        data: [
          'event:event',
          { topic: `example.topic${i}`, data: Buffer.from('x'.repeat(2400)).toString('base64') },
        ],
      })[0],
  );
  let counted = 0;
  const meter = new LaneVolumeMeter((row) => {
    counted += frames(row);
  });
  const recordWindow = (target: LaneVolumeMeter, perRoute: number) => {
    for (let n = 0; n < perRoute; n++)
      for (let connection = 0; connection < 4; connection++)
        for (const packet of packets)
          target.record(`connection${connection}`, `node${connection}`, 'out', packet);
    target.flush();
  };
  await measure('lane-accounting-9600-frames', 30, () => recordWindow(meter, 100));
  if (counted !== (100 + 7 * 30) * 9600) throw new Error('lost accounted frames');

  const monitor = new EventLoopDelayMonitor();
  let tick = 0;
  await measure('event-loop-sample', 500000, () => {
    const at = ++tick * 100;
    monitor.observe(at, at + 1, '2026-01-01T00:00:00.000Z');
  });

  const auditPath = join(root, 'audit.jsonl');
  const audit = await createAudit(auditPath, 4096, { maxBytes: 64 * 1024 * 1024, keep: 0 });
  let auditedFrames = 0;
  const audited = new LaneVolumeMeter((row) => {
    auditedFrames += frames(row);
    audit.write(row);
  });
  await measure('lane-audit-96-routes', 30, async () => {
    recordWindow(audited, 1);
    await audit.flush();
  });
  const status = audit.status();
  await audit.close();
  if (status.dropped !== 0 || status.writeFailures !== 0 || auditedFrames !== (100 + 7 * 30) * 96)
    throw new Error(`audit lost data: ${JSON.stringify(status)}`);
  console.log(
    JSON.stringify({
      benchmark: 'lane-audit-size',
      windows: 310,
      routesPerWindow: 96,
      frames: auditedFrames,
      bytes: statSync(auditPath).size,
      bytesPerWindow: statSync(auditPath).size / 310,
      dropped: status.dropped,
      rssBytes: process.memoryUsage().rss,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
