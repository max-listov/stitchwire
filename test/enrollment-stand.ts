import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { bindUnixSocket } from 'stitchkit/files';
import { runNativeCommand } from 'stitchkit/process';
import {
  EnrollmentAdmissionRequestSchema,
  EnrollmentNodeRequestSchema,
  type EnrollmentOperation,
  type EnrollmentRequest,
  type EnrollmentDescriptor,
  type EnrollmentNodeRequest,
  type EnrollmentProof,
} from '../packages/contracts/src/enrollment/request.ts';
import { EnrollmentResultSchema } from '../packages/contracts/src/enrollment/result.ts';
import { ServiceIngressSchema } from '../packages/contracts/src/service/contracts.ts';
import { ServiceDescriptorSchema } from '../packages/contracts/src/service/policy-schema.ts';
import { SERVICE_TRACE_HEADER } from '../packages/contracts/src/service/diagnostics.ts';
import { type FleetManifest, FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { openBundle, reduceBundle } from '../packages/runtime/src/fleet/bundle.ts';
import { loadNodeConfig, sha256 } from '../packages/runtime/src/config/io.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';
import { createWireClient } from '../packages/local-client/src/client.ts';
import { pastBusy } from './enrollment-lock.ts';
import { fleetSigner } from './signed-fleet.ts';
import { CALL_POLL_MS, PROCESS_START_CEILING_MS, until } from './support.ts';

/** A node request that certifies the broker route; the stand's default request is one. */
export type ProvenRequest = EnrollmentNodeRequest & { proof: EnrollmentProof };

export const enrollmentLimits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 1000 };
export const enrollmentEntry = resolve(import.meta.dir, '../packages/runtime/src/cli/main.ts');

export async function enrollmentStand(
  options: {
    entry?: string;
    workerId?: string;
    /**
     * The worker's configuration is a `node.json` in a directory of its own, so its agent reads the
     * default drop-in directories beside it; otherwise it is `<id>.json`, which has none.
     */
    defaultDropIns?: boolean;
    /**
     * The worker's agent is started through `linked/node.json`, a link to its configuration in another
     * directory, so the agent reads the drop-in directories beside that spelling, not beside the file.
     */
    linkedConfig?: boolean;
  } = {},
) {
  const entry = options.entry ?? enrollmentEntry;
  const workerId = options.workerId ?? 'worker';
  const root = realpathSync(mkdtempSync('/tmp/we-'));
  const children: Bun.Subprocess[] = [];
  const owners: Bun.Server<undefined>[] = [];
  const reached: Array<{ caller: string; service: string; operation: string }> = [];
  const ingressTraces: string[] = [];
  const portHolder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const url = `http://127.0.0.1:${portHolder.port}`;
  await portHolder.stop(true);
  const signing = fleetSigner('test-key');
  const { trust } = signing;
  const manifest = FleetManifestSchema.parse({
    version: 1,
    members: { observer: { copy: 'own' }, [workerId]: { copy: 'own' } },
    access: [{ from: workerId, to: 'observer', services: { 'example.probe': ['service-read'] } }],
    serviceNamespaces: { [workerId]: ['owner.'] },
    topicNamespaces: {
      'owner.events.': {
        producer: workerId,
        subscribers: ['observer'],
        maxTopics: 4,
        maxRetainedBytes: 4096,
      },
    },
    topics: {
      'owner.events.fleet': { producer: workerId, subscribers: ['observer'], delivery: 'ordered' },
    },
  });
  const bundle = signing.edition(manifest, 1);
  let edition = { manifest, serial: 1 };
  const opened = openBundle(bundle, trust, { requireFull: true });
  if (!opened.ok) throw new Error('fixture bundle invalid');
  const verified = opened.opened;
  const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const brokerConfig = join(root, 'broker.json');
  const brokerCopy = join(root, 'broker-fleet.json');
  write(brokerCopy, bundle);
  write(brokerConfig, {
    host: '127.0.0.1',
    port: Number(new URL(url).port),
    nodes: [{ id: 'observer', tokenSha256s: [sha256('observer-secret-token')] }],
    auditPath: join(root, 'audit.jsonl'),
    fleet: { trust, copy: brokerCopy, pollMs: 200 },
  });
  function start(kind: string, config: string, id: string) {
    const state = join(root, id);
    mkdirSync(state, { recursive: true, mode: 0o700 });
    const child = Bun.spawn([process.execPath, entry, kind, '--config', config], {
      stdout: 'ignore',
      stderr: 'ignore',
      env: { ...process.env, STITCHWIRE_CONFIG_DIR: state, STITCHWIRE_STATE_DIR: state },
    });
    children.push(child);
    return child;
  }
  start('broker', brokerConfig, 'broker');
  if (
    !(await until(async () => {
      try {
        return (await fetch(`${url}/health`)).ok;
      } catch {
        return false;
      }
    }, PROCESS_START_CEILING_MS))
  )
    throw new Error('fixture broker unavailable');

  function owner(service: string, index: number) {
    const descriptorPath = join(root, `descriptor${index}.json`);
    const declarationPath = join(root, `declaration${index}.json`);
    const socketPath = join(root, `owner${index}.sock`);
    const topicPath = join(root, `topics${index}.json`);
    const topic = `owner.events.${index}`;
    write(topicPath, { topics: { [topic]: { delivery: 'ordered' } } });
    const descriptor = ServiceDescriptorSchema.parse({
      service,
      revision: '1',
      maxInflight: 4,
      operations: ['read', 'write'].map((id) => ({
        id,
        path: `/${id}`,
        effect: id,
        limits: enrollmentLimits,
        response: { kind: 'unary' },
      })),
    });
    write(descriptorPath, descriptor);
    const binding = {
      service,
      descriptorPath,
      socketPath,
      endpointPath: '/wire',
      maxInflight: 4,
      limits: enrollmentLimits,
    };
    write(declarationPath, { binding, callers: [{ caller: 'observer', scope: { kind: 'service-read' } }] });
    const server = bindUnixSocket({ path: socketPath, mode: 0o600 }, () =>
      Bun.serve({
        unix: socketPath,
        async fetch(req) {
          const ingress = ServiceIngressSchema.parse(await req.json());
          const traceId = req.headers.get(SERVICE_TRACE_HEADER);
          if (traceId !== null) ingressTraces.push(traceId);
          const answer = { caller: ingress.caller, service: ingress.service, operation: ingress.operation };
          reached.push(answer);
          return Response.json(answer);
        },
      }),
    );
    owners.push(server);
    const bindings: EnrollmentDescriptor[] = [
      { kind: 'service', path: declarationPath },
      { kind: 'topic', path: topicPath },
    ];
    return { descriptorPath, declarationPath, descriptor, binding, topicPath, topic, bindings };
  }
  const probe = owner('example.probe', 0);
  const first = owner('owner.first', 1);
  const second = owner('owner.second', 2);
  function nodeConfig(id: string, token: string, beside = false) {
    if (beside) mkdirSync(join(root, id), { mode: 0o700 });
    const config = beside ? join(root, id, 'node.json') : join(root, `${id}.json`);
    const socket = join(root, `${id}.sock`);
    const copy = join(root, `${id}-fleet.json`);
    const reduced = reduceBundle(verified, id);
    write(copy, reduced);
    write(config, {
      nodeId: id,
      agentSocket: socket,
      brokers: [{ id: 'primary', url, token }],
      fleet: { trust, copy, pollMs: 200 },
      ...(id === 'observer'
        ? {
            services: {
              bindings: [probe.binding],
              grants: [
                {
                  caller: workerId,
                  target: 'observer',
                  service: 'example.probe',
                  scope: { kind: 'service-read' },
                },
              ],
            },
          }
        : {}),
    });
    return { config, socket };
  }
  async function waitSettled(socketPath: string, label: string, requireAligned = false) {
    const client = createWireClient({ socketPath });
    try {
      // A fresh agent connects, holds its configuration to the kept edition and reloads once to run
      // it: its door is replaced a moment after the first connection. The agent is ready when it
      // is connected AND its configuration is settled, so no caller meets that gap.
      if (
        !(await until(async () => {
          try {
            const { connected, bundle } = await client.status();
            const aligned =
              bundle.config === 'aligned' || (!requireAligned && bundle.config === 'unconfigured');
            return connected && aligned;
          } catch {
            return false;
          }
        }, PROCESS_START_CEILING_MS))
      )
        throw new Error(`${label} not admitted`);
    } finally {
      client.close();
    }
  }
  const observer = nodeConfig('observer', 'observer-secret-token');
  start('agent', observer.config, 'observer');
  await waitSettled(observer.socket, 'observer', true);
  const worker = nodeConfig(workerId, 'worker-secret-token', options.defaultDropIns);
  const linkedConfig = join(root, 'linked', 'node.json');
  if (options.linkedConfig) {
    mkdirSync(join(root, 'linked'), { mode: 0o700 });
    symlinkSync(worker.config, linkedConfig);
  }
  const agentConfig = options.linkedConfig ? linkedConfig : worker.config;
  const material = join(root, 'material.json');
  write(material, { trust, bundle: reduceBundle(verified, workerId) });
  const proof: EnrollmentProof = {
    descriptor: probe.descriptorPath,
    call: {
      to: 'observer',
      service: 'example.probe',
      revision: '1',
      operation: 'read',
      payload: '{}',
      timeoutMs: 1000,
    },
    responseSha256: sha256(JSON.stringify({ caller: workerId, service: 'example.probe', operation: 'read' })),
  };
  const request: ProvenRequest = {
    ...EnrollmentNodeRequestSchema.parse({
      v: 1,
      kind: 'node',
      requestId: crypto.randomUUID(),
      nodeId: workerId,
      expectedVersion: RELEASE_VERSION,
      config: worker.config,
      material,
      brokers: [{ id: 'primary', url }],
      agentSocket: worker.socket,
      supervisor: { kind: 'existing' },
      owner: { id: 'first', descriptors: first.bindings },
      proof,
    }),
    proof,
  };
  const admission = EnrollmentAdmissionRequestSchema.parse({
    v: 1,
    kind: 'admission',
    requestId: crypto.randomUUID(),
    nodeId: workerId,
    expectedVersion: RELEASE_VERSION,
    config: brokerConfig,
    tokenSha256: sha256('worker-secret-token'),
  });

  /** One attempt, as the binary answers it: `busy` at once when the configuration lock is held. */
  async function cliOnce(value: EnrollmentRequest, operation: EnrollmentOperation) {
    const path = join(root, `request-${value.requestId}.json`);
    write(path, value);
    const result = await runNativeCommand({
      executable: process.execPath,
      args: [entry, 'enroll', operation, '--request', path],
      capture: true,
      maxOutputBytes: 2 * 1024 * 1024,
      timeoutMs: 28_000,
    });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    if (stdout.includes('worker-secret-token') || stderr.includes('worker-secret-token'))
      throw new Error('credential reached process output');
    if (value.kind === 'node' && existsSync(value.config)) {
      for (const broker of loadNodeConfig(value.config).brokers)
        if (stdout.includes(broker.token) || stderr.includes(broker.token))
          throw new Error('generated credential reached process output');
    }
    return { code: result.exitCode, result: EnrollmentResultSchema.parse(JSON.parse(stdout)) };
  }
  /** The CLI as an orchestrator drives it: a `busy` configuration is asked again, boundedly. */
  const cli = (value: EnrollmentRequest, operation: EnrollmentOperation) =>
    pastBusy(
      () => cliOnce(value, operation),
      (answer) => answer.result,
    );
  async function startWorker() {
    const child = start('agent', agentConfig, 'worker');
    await waitSettled(worker.socket, 'worker');
    // Broker admission reloads the broker and drops observer's lane momentarily; wait until
    // observer is back online too before returning a settled two-node stand.
    await waitSettled(observer.socket, 'observer', true);
    return child;
  }
  /**
   * The proof route is live: the worker reaches the observer's declared service through the broker.
   * Both agents connected and aligned is not yet this — after the admission reload the broker learns
   * the observer's service again only when the observer redeclares it — so a step that needs the
   * route waits for the route itself, not for its preconditions.
   */
  async function awaitProofRoute(): Promise<void> {
    const client = createWireClient({ socketPath: worker.socket });
    try {
      const routed = await until(
        async () => {
          const { outcome } = await client.invokeService(request.proof.call);
          return outcome.status === 'response' && outcome.httpStatus === 200;
        },
        PROCESS_START_CEILING_MS,
        CALL_POLL_MS,
      );
      if (!routed) throw new Error('the proof route did not open');
    } finally {
      client.close();
    }
  }
  return {
    root,
    url,
    write,
    request,
    admission,
    cli,
    cliOnce,
    async fleetApply() {
      const result = await runNativeCommand({
        executable: process.execPath,
        args: [entry, 'fleet', 'apply', '--config', worker.config],
        capture: true,
        maxOutputBytes: 65536,
        timeoutMs: 10_000,
      });
      return {
        code: result.exitCode,
        text: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
      };
    },
    startWorker,
    awaitProofRoute,
    reached,
    ingressTraces,
    first,
    second,
    probe,
    brokerConfig,
    brokerCopy,
    bundle,
    trust,
    observer,
    worker,
    /** The configuration path the worker's agent is started with. */
    agentConfig,
    config: () => loadNodeConfig(worker.config),
    /** Sign the next edition and hand it to the broker, as a fleet publication of another change would. */
    publish(change: (manifest: FleetManifest) => FleetManifest): number {
      edition = { manifest: FleetManifestSchema.parse(change(edition.manifest)), serial: edition.serial + 1 };
      write(brokerCopy, signing.edition(edition.manifest, edition.serial));
      return edition.serial;
    },
    async stop() {
      for (const child of children) child.kill();
      await Promise.all(children.map((child) => child.exited));
      for (const server of owners) await server.stop(true);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
