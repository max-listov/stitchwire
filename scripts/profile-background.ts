/*
 * A connected stand with no owner calls, profiled in-process: a broker and an agent with fleet
 * copies, declarations and the event-loop monitor, nothing calling through them. It is not a
 * profiler of a live process. Counted passes are not CPU shares, and JavaScript sample proportions
 * do not explain kernel or thread-pool time; production CPU and causal A/B are measured separately.
 */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { FleetFollower } from '../packages/runtime/src/node/fleet-follower.ts';
import { FleetKeeper } from '../packages/runtime/src/broker/fleet-keeper.ts';
import { ServiceDeclarer } from '../packages/runtime/src/node/service-declarations.ts';
import { TopicDeclarer } from '../packages/runtime/src/node/topic-declarations.ts';
import { EventLoopDelayMonitor } from '../packages/runtime/src/broker/event-loop-delay.ts';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { ServiceDeclarationSchema } from '../packages/contracts/src/service/declaration.ts';
import { TopicDescriptorSchema } from '../packages/contracts/src/protocol/topic.ts';
import { generateSigningKey } from '../packages/runtime/src/fleet/signature.ts';
import { buildBundle } from '../packages/runtime/src/fleet/bundle.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';
import { brokerConfig, freePort, until, waitConnected } from '../test/support.ts';

/** A stand, not an attachment to production. Only topology cardinalities cross the boundary;
 * no live credentials, owner sockets, projected configs or service calls enter it. Run each role
 * separately under --cpu-prof; the opposite role is a distinct process, excluded from self CPU. */
const options = z
  .object({
    role: z.enum(['agent', 'broker', 'peer-broker', 'peer-agent']),
    seconds: z.coerce.number().int().min(1).max(1800),
    root: z.string().optional(),
    port: z.coerce.number().int().min(1).max(65535).optional(),
  })
  .parse({ role: Bun.argv[2], seconds: Bun.argv[3] ?? 600, root: Bun.argv[4], port: Bun.argv[5] });
const counters: Record<string, number> = {};
function count(prototype: object, method: string, name: string): void {
  const original: unknown = Reflect.get(prototype, method);
  if (typeof original !== 'function') throw new Error(`missing profiling point ${name}`);
  Reflect.set(prototype, method, function (this: object, ...args: unknown[]) {
    counters[name] = (counters[name] ?? 0) + 1;
    return Reflect.apply(original, this, args);
  });
}
count(FleetFollower.prototype, 'poll', 'fleet-agent-poll');
count(FleetKeeper.prototype, 'poll', 'fleet-broker-poll');
count(ServiceDeclarer.prototype, 'refresh', 'service-declarations');
count(TopicDeclarer.prototype, 'refresh', 'topic-declarations');
count(EventLoopDelayMonitor.prototype, 'observe', 'event-loop-sample');
const root = options.root ?? (await mkdtemp(join(tmpdir(), 'wire-profile-')));
const token = 'p'.repeat(40);
const ready = join(root, 'ready.json');
const manifestPath = join(root, 'manifest.json');
const childRole = options.role === 'broker' ? 'peer-agent' : 'peer-broker';
let peer: ReturnType<typeof Bun.spawn> | undefined;
let agent: Awaited<ReturnType<typeof startAgent>> | undefined;
let broker: Awaited<ReturnType<typeof startBroker>> | undefined;
try {
  if (options.root === undefined) {
    const signer = generateSigningKey();
    const manifest = FleetManifestSchema.parse({
      version: 1,
      members: Object.fromEntries(Array.from({ length: 5 }, (_, n) => [`node${n}`, { copy: 'full' }])),
      access: [],
      serviceNamespaces: { node0: ['example.'] },
    });
    await writeFile(
      join(root, 'bundle.json'),
      JSON.stringify(
        buildBundle({
          manifest,
          serial: 1,
          issuedAt: '2026-01-01T00:00:00.000Z',
          keyId: 'profile',
          privateKeyPem: signer.privateKeyPem,
        }),
      ),
    );
    await writeFile(
      manifestPath,
      JSON.stringify({
        copy: join(root, 'bundle.json'),
        trust: [{ id: 'profile', publicKey: signer.publicKey }],
      }),
    );
    for (let n = 0; n < 6; n++)
      await writeFile(
        join(root, `service${n}.json`),
        JSON.stringify(
          ServiceDeclarationSchema.parse({
            binding: {
              service: `example.service${n}`,
              descriptorPath: join(root, `descriptor${n}.json`),
              socketPath: join(root, `owner${n}.sock`),
              endpointPath: '/invoke',
              maxInflight: 4,
              limits: { requestBytes: 1024, responseBytes: 65536, timeoutMs: 2000 },
            },
            callers: [],
          }),
        ),
      );
    await writeFile(join(root, 'topics.json'), JSON.stringify(TopicDescriptorSchema.parse({ topics: {} })));
  }
  const fleet = await Bun.file(manifestPath).json();
  if (options.role === 'broker' || options.role === 'peer-broker') {
    broker = await startBroker(
      brokerConfig(Object.fromEntries(Array.from({ length: 5 }, (_, n) => [`node${n}`, token])), {
        port: freePort(),
        auditPath: join(root, 'audit.jsonl'),
        serviceNamespaces: { node0: ['example.'] },
        fleet,
      }),
    );
    await writeFile(ready, JSON.stringify({ port: broker.port }));
  }
  if (options.root === undefined) {
    peer = Bun.spawn(
      [
        process.execPath,
        Bun.argv[1] ?? '',
        childRole,
        String(options.seconds + 30),
        root,
        String(broker?.port ?? 1),
      ],
      { stdout: 'ignore', stderr: 'inherit' },
    );
  }
  if (options.role === 'agent' || options.role === 'peer-agent') {
    if (!(await until(() => Bun.file(ready).exists()))) throw new Error('stand broker did not start');
    const endpoint = z.object({ port: z.number().int().positive() }).parse(await Bun.file(ready).json());
    agent = await startAgent(
      NodeConfigSchema.parse({
        nodeId: 'node0',
        fleet,
        agentSocket: join(root, 'agent.sock'),
        brokers: [{ id: 'stand', url: `http://127.0.0.1:${endpoint.port}`, token }],
        services: {
          bindings: [],
          grants: [],
          namespaces: ['example.'],
          descriptors: Array.from({ length: 6 }, (_, n) => join(root, `service${n}.json`)),
        },
        events: { namespaces: { publish: ['example.'] }, descriptors: [join(root, 'topics.json')] },
      }),
    );
    await waitConnected(agent);
    await writeFile(join(root, 'agent-ready'), 'ready');
  }
  const isPeer = options.root !== undefined;
  if (isPeer) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        process.removeListener('SIGTERM', finish);
        resolve();
      };
      const timer = setTimeout(finish, options.seconds * 1000);
      process.once('SIGTERM', finish);
    });
  } else {
    const peerReady = await until(() => {
      if (peer?.exitCode !== null) throw new Error('stand peer exited before readiness');
      return Bun.file(join(root, 'agent-ready')).exists();
    });
    if (!peerReady) throw new Error('stand peer did not start');
    // A warm-up the sample excludes: the clock is the instrument of a profile, not a stand-in for a state.
    await Bun.sleep(2000);
    const startedAt = new Date().toISOString(),
      started = performance.now(),
      before = process.cpuUsage();
    const first = { ...counters };
    const deadline = started + options.seconds * 1000;
    while (performance.now() < deadline) await Bun.sleep(Math.max(1, deadline - performance.now()));
    const cpu = process.cpuUsage(before),
      elapsedMs = performance.now() - started;
    const status = agent === undefined ? null : await agent.status();
    if (peer?.exitCode !== null) throw new Error('stand peer exited during sample');
    if (status !== null && !agent?.connected) throw new Error('stand agent did not stay connected');
    console.log(
      JSON.stringify({
        role: options.role,
        version: RELEASE_VERSION,
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
        startedAt,
        endedAt: new Date().toISOString(),
        elapsedMs,
        cpu,
        selfPercentOneCore: (cpu.user + cpu.system) / elapsedMs / 10,
        passes: Object.fromEntries(
          Object.entries(counters).map(([key, value]) => [key, value - (first[key] ?? 0)]),
        ),
        workload:
          'connected isolated stand, no owner calls; five roster members, six declarations, one topic file; one connected lane',
        qualification:
          'CPU profile includes startup and shutdown; counters and self CPU exclude warmup. Stand is not a live function attribution or a matched historic production workload.',
      }),
    );
  }
} finally {
  await agent?.stop();
  if (peer !== undefined) {
    peer.kill('SIGTERM');
    await peer.exited;
  }
  await broker?.stop();
  if (options.root === undefined) await rm(root, { recursive: true, force: true });
}
