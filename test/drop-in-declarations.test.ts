import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindUnixSocket } from 'stitchkit/files';
import {
  createWireClient,
  removeServiceDeclarationFile,
  removeTopicDescriptorFile,
  writeServiceDeclarationFile,
  writeTopicDescriptorFile,
} from '../packages/client/src/index.ts';
import { ServiceIngressSchema } from '../packages/contracts/src/service/contracts.ts';
import { ServiceDescriptorSchema } from '../packages/contracts/src/service/policy-schema.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { ServiceDeclarer } from '../packages/runtime/src/node/service-declarations.ts';
import { TopicDeclarer } from '../packages/runtime/src/node/topic-declarations.ts';
import { brokerConfig, freePort, until, waitConnected } from './support.ts';

const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 };

describe('drop-in declaration directories (services.d and events.d)', () => {
  test('SDK write/remove helpers survive umask 0777, are idempotent and refuse traversal/invalid inputs', async () => {
    const work = await mkdtemp(join(tmpdir(), 'sw-dropin-sdk-'));
    const previousMask = process.umask(0o777);
    try {
      const configPath = join(work, 'nested/conf/node.json');
      const written = await writeTopicDescriptorFile(
        'owner-app',
        { topics: { 'owner.node.checks': { delivery: 'ordered', publicationMode: 'on-change' } } },
        { configPath },
      );
      expect(written.changed).toBe(true);
      expect(written.path).toBe(join(work, 'nested/conf/events.d/owner-app.json'));
      expect((await stat(join(work, 'nested/conf/events.d'))).mode & 0o777).toBe(0o700);
      expect((await stat(written.path)).mode & 0o777).toBe(0o600);

      // Idempotent repeat returns changed: false
      const repeat = await writeTopicDescriptorFile(
        'owner-app.json',
        { topics: { 'owner.node.checks': { delivery: 'ordered', publicationMode: 'on-change' } } },
        { configPath },
      );
      expect(repeat).toEqual({ path: written.path, changed: false });

      // Overly permissive mode (0666) is repaired back to 0600 even when bytes match
      await chmod(written.path, 0o666);
      const repaired = await writeTopicDescriptorFile(
        'owner-app',
        { topics: { 'owner.node.checks': { delivery: 'ordered', publicationMode: 'on-change' } } },
        { configPath },
      );
      expect(repaired).toEqual({ path: written.path, changed: true });
      expect((await stat(written.path)).mode & 0o777).toBe(0o600);

      // Remove and idempotent second remove
      expect(await removeTopicDescriptorFile('owner-app', { configPath })).toEqual({
        path: written.path,
        removed: true,
      });
      expect(await removeTopicDescriptorFile('owner-app', { configPath })).toEqual({
        path: written.path,
        removed: false,
      });

      // Traversal, double extensions, trailing dots and invalid names refused
      for (const badName of [
        '../escape',
        '.hidden',
        'a/b',
        'UPPER',
        '',
        'foo.',
        'foo..json',
        'a.json.json',
      ]) {
        await expect(writeTopicDescriptorFile(badName, { topics: {} }, { configPath })).rejects.toMatchObject(
          { code: 'invalid-request' },
        );
      }

      // Removal through a symlinked dropInDir is refused before unlinking inside the target
      const externalDir = join(work, 'external-dir');
      await mkdir(externalDir, { mode: 0o700 });
      await chmod(externalDir, 0o700);
      const victim = join(externalDir, 'victim.json');
      await writeFile(victim, '{}', { mode: 0o600 });
      await chmod(victim, 0o600);
      const symlinkDropIn = join(work, 'linked-events.d');
      await symlink(externalDir, symlinkDropIn);
      await expect(removeTopicDescriptorFile('victim', { dropInDir: symlinkDropIn })).rejects.toMatchObject({
        code: 'permission',
      });
      expect(await readFile(victim, 'utf8')).toBe('{}');

      // Invalid schema refused before touching disk
      await expect(
        writeServiceDeclarationFile('bad', { binding: {} } as never, { configPath }),
      ).rejects.toMatchObject({ code: 'invalid-request' });
    } finally {
      process.umask(previousMask);
      await rm(work, { recursive: true, force: true });
    }
  });

  test('live agent hot-loads and hot-withdraws services.d and events.d without editing node.json or restarting', async () => {
    const work = await mkdtemp(join(tmpdir(), 'sw-dropin-live-'));
    const port = freePort();
    const workerToken = 'worker-secret-token-dropin';
    const readerToken = 'reader-secret-token-dropin';
    const broker = await startBroker(
      brokerConfig(
        { worker: workerToken, reader: readerToken },
        {
          port,
          capabilities: {
            worker: [{ operation: 'publish', targets: ['*'] }],
            reader: [{ operation: 'subscribe', targets: ['*'] }],
          },
          serviceNamespaces: { worker: ['owner.'] },
          topicNamespaces: {
            'owner.': { producer: 'worker', subscribers: ['reader'], maxTopics: 8, maxRetainedBytes: 8192 },
          },
        },
      ),
    );

    const descriptor1 = join(work, 'svc1-descriptor.json');
    const descriptor2 = join(work, 'svc2-descriptor.json');
    const svc1Sock = join(work, 'svc1.sock');
    const svc2Sock = join(work, 'svc2.sock');
    const makeDescriptor = (service: string) =>
      ServiceDescriptorSchema.parse({
        service,
        revision: '1',
        maxInflight: 4,
        operations: [
          { id: 'ping', path: '/ping', effect: 'read', limits, response: { kind: 'unary' } },
          { id: 'feed', path: '/feed', effect: 'read', limits, response: { kind: 'stream' } },
        ],
      });
    await writeFile(descriptor1, JSON.stringify(makeDescriptor('owner.alpha')));
    await writeFile(descriptor2, JSON.stringify(makeDescriptor('owner.beta')));

    const serveOwner = (socketPath: string, label: string) =>
      bindUnixSocket({ path: socketPath, mode: 0o600 }, () =>
        Bun.serve({
          unix: socketPath,
          async fetch(req) {
            const ingress = ServiceIngressSchema.parse(await req.json());
            return Response.json({ label, op: ingress.operation, caller: ingress.caller });
          },
        }),
      );
    const owner1 = serveOwner(svc1Sock, 'alpha');
    const owner2 = serveOwner(svc2Sock, 'beta');

    const workerConfigPath = join(work, 'worker-conf/node.json');
    await mkdir(join(work, 'worker-conf'), { recursive: true, mode: 0o700 });
    const workerConfig = NodeConfigSchema.parse({
      nodeId: 'worker',
      agentSocket: join(work, 'worker.sock'),
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token: workerToken }],
      services: { bindings: [], grants: [], namespaces: ['owner.'], descriptors: [] },
      events: {
        publish: [],
        subscribe: [],
        namespaces: { publish: ['owner.'], subscribe: [] },
        descriptors: [],
      },
    });
    const nodeJsonRaw = `${JSON.stringify(workerConfig, null, 2)}\n`;
    await writeFile(workerConfigPath, nodeJsonRaw, { mode: 0o600 });
    const nodeJsonDigest = sha256(nodeJsonRaw);

    const readerConfig = NodeConfigSchema.parse({
      nodeId: 'reader',
      agentSocket: join(work, 'reader.sock'),
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token: readerToken }],
      services: { bindings: [], grants: [], namespaces: [], descriptors: [] },
      events: {
        publish: [],
        subscribe: [],
        namespaces: { publish: [], subscribe: ['owner.'] },
        descriptors: [],
      },
    });

    const worker = await startAgent(workerConfig, { path: workerConfigPath });
    const reader = await startAgent(readerConfig);
    const workerClient = createWireClient({ socketPath: worker.socketPath });
    const readerClient = createWireClient({ socketPath: reader.socketPath });

    try {
      await waitConnected(worker);
      await waitConnected(reader);

      // Write TWO services and ONE topic descriptor via drop-in helpers — zero edits to node.json, zero restarts!
      await writeServiceDeclarationFile(
        'alpha',
        {
          binding: {
            service: 'owner.alpha',
            descriptorPath: descriptor1,
            socketPath: svc1Sock,
            endpointPath: '/wire',
            maxInflight: 4,
            limits,
          },
          callers: [{ caller: 'reader', scope: { kind: 'service-read' } }],
        },
        { configPath: workerConfigPath },
      );
      await writeServiceDeclarationFile(
        'beta',
        {
          binding: {
            service: 'owner.beta',
            descriptorPath: descriptor2,
            socketPath: svc2Sock,
            endpointPath: '/wire',
            maxInflight: 4,
            limits,
          },
          callers: [{ caller: 'reader', scope: { kind: 'service-read' } }],
        },
        { configPath: workerConfigPath },
      );
      await writeTopicDescriptorFile(
        'owner-events',
        { topics: { 'owner.live.ping': { delivery: 'ordered', publicationMode: 'on-change' } } },
        { configPath: workerConfigPath },
      );

      // Wait for automatic 5s poll to pick up both services and the topic without restarting worker.
      expect(
        await until(async () => {
          const st = await workerClient.status();
          return (
            st.services.declarations.descriptors.filter((d) => d.state === 'loaded').length === 2 &&
            st.services.declarations.lanes[0]?.accepted === 2 &&
            st.events.declarations.descriptors.filter((d) => d.state === 'loaded').length === 1 &&
            st.events.declarations.lanes[0]?.accepted === 1
          );
        }, 12_000),
      ).toBe(true);

      // Both hot-loaded services answer RPCs immediately.
      const resA = await readerClient.invokeService({
        to: 'worker',
        service: 'owner.alpha',
        revision: '1',
        operation: 'ping',
        payload: '{}',
        timeoutMs: 2000,
      });
      const resB = await readerClient.invokeService({
        to: 'worker',
        service: 'owner.beta',
        revision: '1',
        operation: 'ping',
        payload: '{}',
        timeoutMs: 2000,
      });
      expect(resA.outcome.status === 'response' && JSON.parse(resA.outcome.payload).label).toBe('alpha');
      expect(resB.outcome.status === 'response' && JSON.parse(resB.outcome.payload).label).toBe('beta');

      // Publish on the hot-loaded topic succeeds.
      const pub = await workerClient.publish({
        topic: 'owner.live.ping',
        bootId: crypto.randomUUID(),
        seq: 1,
        data: Buffer.from('hi').toString('base64'),
      });
      expect(pub.ok).toBe(true);

      // node.json was NEVER modified.
      expect(sha256(await readFile(workerConfigPath, 'utf8'))).toBe(nodeJsonDigest);

      // Hot-remove both drop-in files and confirm withdrawal without restart.
      await removeServiceDeclarationFile('alpha', { configPath: workerConfigPath });
      await removeTopicDescriptorFile('owner-events', { configPath: workerConfigPath });

      expect(
        await until(async () => {
          const st = await workerClient.status();
          return (
            st.services.declarations.descriptors.length === 1 &&
            st.services.declarations.lanes[0]?.accepted === 1 &&
            st.events.declarations.descriptors.length === 0 &&
            st.events.declarations.lanes[0]?.accepted === 0
          );
        }, 12_000),
      ).toBe(true);

      // Withdrawn service is refused.
      const afterRemove = await readerClient.invokeService({
        to: 'worker',
        service: 'owner.alpha',
        revision: '1',
        operation: 'ping',
        payload: '{}',
        timeoutMs: 2000,
      });
      expect(afterRemove.outcome.status).toBe('failure');
    } finally {
      workerClient.close();
      readerClient.close();
      await worker.stop();
      await reader.stop();
      await broker.stop();
      await owner1.stop(true);
      await owner2.stop(true);
      await rm(work, { recursive: true, force: true });
    }
  }, 30_000);

  test('fail-closed security controls: group-writable dir, symlinks, overflow cap, and deleted topic lastValid cleanup', async () => {
    const work = await mkdtemp(join(tmpdir(), 'sw-dropin-sec-'));
    try {
      const eventsDir = join(work, 'events.d');
      await mkdir(eventsDir, { mode: 0o700 });
      const topicsFile = join(eventsDir, 'one.json');
      await writeFile(topicsFile, JSON.stringify({ topics: { 'owner.a': { delivery: 'ordered' } } }), {
        mode: 0o600,
      });

      let declaredTopics: string[] = [];
      const topicDeclarer = new TopicDeclarer(
        'worker',
        { descriptors: [], namespaces: { publish: ['owner.'] } },
        5000,
        eventsDir,
      );
      topicDeclarer.attach('primary', {
        connected: true,
        declareTopics: async (req) => {
          declaredTopics = Object.keys(req.topics);
          return { accepted: declaredTopics, refused: [] };
        },
      });
      await topicDeclarer.refresh();
      expect(declaredTopics).toEqual(['owner.a']);

      // Remove drop-in file -> withdraws immediately AND prunes lastValid!
      await rm(topicsFile);
      await topicDeclarer.refresh();
      expect(declaredTopics).toEqual([]);
      expect(topicDeclarer.snapshot().descriptors).toEqual([]);

      // Re-create same filename with BROKEN JSON -> must NOT resurrect old 'owner.a'!
      await writeFile(topicsFile, '{broken', { mode: 0o600 });
      await topicDeclarer.refresh();
      expect(declaredTopics).toEqual([]);
      expect(topicDeclarer.snapshot().descriptors[0]?.state).toBe('invalid');
      await rm(topicsFile);

      // Symlink inside drop-in directory -> refused by O_NOFOLLOW!
      const outside = join(work, 'outside.json');
      await writeFile(outside, JSON.stringify({ topics: { 'owner.evil': { delivery: 'ordered' } } }), {
        mode: 0o600,
      });
      await symlink(outside, join(eventsDir, 'link.json'));
      await topicDeclarer.refresh();
      expect(declaredTopics).toEqual([]);
      expect(topicDeclarer.snapshot().descriptors[0]?.state).toBe('invalid');
      await rm(join(eventsDir, 'link.json'));

      // Group/world-writable drop-in directory -> refused fail-closed with one summary invalid entry!
      await writeFile(topicsFile, JSON.stringify({ topics: { 'owner.valid': { delivery: 'ordered' } } }), {
        mode: 0o600,
      });
      await chmod(eventsDir, 0o775);
      await topicDeclarer.refresh();
      expect(declaredTopics).toEqual([]);
      expect(topicDeclarer.snapshot().descriptors).toEqual([
        expect.objectContaining({ path: eventsDir, state: 'invalid' }),
      ]);
      await chmod(eventsDir, 0o700);
      await rm(topicsFile);

      // Overflow beyond MAX_TOPIC_DESCRIPTOR_FILES (16) -> capped to 16 + 1 summary invalid entry (17 total)
      for (let i = 0; i < 20; i++) {
        await writeFile(
          join(eventsDir, `f-${String(i).padStart(2, '0')}.json`),
          JSON.stringify({ topics: { [`owner.t${i}`]: { delivery: 'ordered' } } }),
          { mode: 0o600 },
        );
      }
      await topicDeclarer.refresh();
      expect(declaredTopics.length).toBe(16);
      expect(topicDeclarer.snapshot().descriptors.length).toBe(17);
      expect(topicDeclarer.snapshot().descriptors[16]).toMatchObject({
        path: eventsDir,
        state: 'invalid',
      });

      // Deduplication: same file listed in node.json descriptors AND inside services.d/ is read once.
      const svcDir = join(work, 'services.d');
      await mkdir(svcDir, { mode: 0o700 });
      const dupPath = join(svcDir, 'dup.json');
      await writeFile(
        dupPath,
        JSON.stringify({
          binding: {
            service: 'owner.dup',
            descriptorPath: join(work, 'd.json'),
            socketPath: join(work, 's.sock'),
            endpointPath: '/wire',
            maxInflight: 4,
            limits,
          },
          callers: [],
        }),
        { mode: 0o600 },
      );
      // Cyclic symlink AND symlink pointing at the explicit file must NOT crash refresh() and must report invalid.
      await symlink(join(svcDir, 'loop.json'), join(svcDir, 'loop.json'));
      await symlink(dupPath, join(svcDir, 'alias.json'));
      const svcDeclarer = new ServiceDeclarer(
        'worker',
        { bindings: [], grants: [], namespaces: ['owner.'], descriptors: [dupPath] },
        () => {},
        5000,
        svcDir,
      );
      await svcDeclarer.refresh();
      expect(svcDeclarer.snapshot().descriptors.find((d) => d.path === dupPath)?.state).toBe('loaded');
      expect(svcDeclarer.snapshot().descriptors.find((d) => d.path.endsWith('loop.json'))?.state).toBe(
        'invalid',
      );
      expect(svcDeclarer.snapshot().descriptors.find((d) => d.path.endsWith('alias.json'))?.state).toBe(
        'invalid',
      );
      expect(svcDeclarer.snapshot().refused).toEqual([]);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  test('streamExecutionAdmission reserves slots for 2+ concurrent drop-in services and fleet projection preserves dropInDir', async () => {
    const { streamExecutionAdmission } = await import('../packages/runtime/src/node/admission.ts');
    const { applyNodeTables } = await import('../packages/runtime/src/fleet/projection.ts');
    const baseConfig = NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers: [{ id: 'primary', url: 'http://127.0.0.1:8790', token: 'secret-token-for-admission-test' }],
      services: {
        bindings: [],
        grants: [],
        namespaces: ['owner.'],
        descriptors: [],
        dropInDir: '/opt/stitchwire/services.d',
      },
      events: {
        publish: [],
        subscribe: [],
        namespaces: { publish: ['owner.'], subscribe: [] },
        descriptors: [],
        dropInDir: null,
      },
    });

    // Negative control: without a drop-in directory no key is reserved beyond bindings and
    // descriptors, so with none of either the second concurrent service is a key-capacity refusal.
    const unreserved = streamExecutionAdmission(baseConfig, false);
    const only = unreserved.acquire('service:owner.alpha');
    const second = unreserved.acquire('service:owner.beta');
    expect(only.accepted).toBe(true);
    expect(second).toMatchObject({
      accepted: false,
      refused: { detail: 'node stream producer inflight limit reached' },
    });
    if (only.accepted) only.release();

    // With a drop-in directory, 2+ hot-added services succeed concurrently.
    const admission = streamExecutionAdmission(baseConfig, true);
    const leaseA = admission.acquire('service:owner.alpha');
    const leaseB = admission.acquire('service:owner.beta');
    const leaseC = admission.acquire('service:owner.gamma');
    expect([leaseA.accepted, leaseB.accepted, leaseC.accepted]).toEqual([true, true, true]);
    if (leaseA.accepted) leaseA.release();
    if (leaseB.accepted) leaseB.release();
    if (leaseC.accepted) leaseC.release();

    // Fleet projection preserves both explicit dropInDir and dropInDir: null.
    const projected = NodeConfigSchema.parse(
      applyNodeTables(baseConfig, {
        events: { publish: [], subscribe: [], namespaces: { publish: ['owner.'], subscribe: [] } },
        services: { grants: [], namespaces: ['owner.'] },
      }),
    );
    expect(projected.services?.dropInDir).toBe('/opt/stitchwire/services.d');
    expect(projected.events.dropInDir).toBeNull();
  });
});
