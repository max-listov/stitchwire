import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runNativeCommand } from 'stitchkit/process';
import { bindUnixSocket } from 'stitchkit/files';
import { createServiceFetch, createServiceIngress, createWireClient } from '../packages/client/src/index.ts';
import type { ServiceClientTrace } from '../packages/contracts/src/service/diagnostics.ts';
import type { ServiceDescriptor, ServiceGrant } from '../packages/contracts/src/service/policy-schema.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { brokerConfig, freePort, waitConnected } from './support.ts';

/**
 * A service owner's whole path, as a consumer meets it: the owner serves `createServiceIngress` on a
 * Unix socket behind a worker agent, a reader agent holds the read grant, and the caller is a
 * `createWireClient` on the reader's door wrapped in `createServiceFetch`. Every call a test makes
 * crosses the client, the door, two agents and a broker.
 */

export interface DoorStand {
  /** The owner's own socket: where a sender that is not an agent would arrive. */
  readonly ownerSocket: string;
  readonly wire: ReturnType<typeof createWireClient>;
  readonly policy: ReturnType<typeof NodeConfigSchema.parse>['services'];
  /** The caller's fetch, addressed to `http://owner.invalid`. */
  call: ReturnType<typeof createServiceFetch>;
  /** A POST to one of the descriptor's paths: `{}` unless a body is given. */
  post(path: string, signal?: AbortSignal, body?: string): Promise<Response>;
  stop(): Promise<void>;
}

export interface DoorStandOptions {
  descriptor: ServiceDescriptor;
  activatePolicy?: boolean;
  /** The owner's handler: what the ingress hands a request that the descriptor declares. */
  owner(request: Request): Response | Promise<Response>;
  /** The ingress's read deadline for the envelope, when a test narrows it. */
  bodyTimeoutMs?: number;
  /** The caller's observer of every unary call's trace. */
  onTrace?: (trace: ServiceClientTrace) => void;
}

export async function startDoorStand({
  descriptor,
  activatePolicy = false,
  owner,
  bodyTimeoutMs,
  onTrace,
}: DoorStandOptions): Promise<DoorStand> {
  const root = await mkdtemp('/tmp/wire-door-');
  const ownerSocket = `${root}/owner.sock`;
  const server = bindUnixSocket({ path: ownerSocket, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      fetch: createServiceIngress({
        descriptor,
        handler: owner,
        ...(bodyTimeoutMs === undefined ? {} : { bodyTimeoutMs }),
      }),
    }),
  );
  const descriptorPath = `${root}/descriptor.json`;
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  const readerToken = 'reader-door-token'.padEnd(40, 'x');
  const workerToken = 'worker-door-token'.padEnd(40, 'x');
  const grant: ServiceGrant = {
    caller: 'reader',
    target: 'worker',
    service: descriptor.service,
    scope: { kind: 'service-read' },
  };
  const port = freePort();
  const broker = await startBroker(
    brokerConfig(
      { reader: readerToken, worker: workerToken },
      {
        port,
        serviceGrants: [grant],
        capabilities: { reader: [{ operation: 'stream', targets: ['worker'] }] },
      },
    ),
  );
  const url = `http://127.0.0.1:${port}`;
  const reader = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'reader',
      brokers: [{ id: 'primary', url, token: readerToken }],
      agentSocket: `${root}/reader.sock`,
    }),
  );
  let workerConfig = NodeConfigSchema.parse({
    nodeId: 'worker',
    brokers: [{ id: 'primary', url, token: workerToken }],
    agentSocket: `${root}/worker.sock`,
    services: {
      grants: [grant],
      bindings: [
        {
          service: descriptor.service,
          descriptorPath,
          socketPath: ownerSocket,
          endpointPath: '/invoke',
          maxInflight: 4,
          limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 20_000 },
        },
      ],
    },
  });

  if (activatePolicy) {
    const path = `${root}/worker.json`;
    await writeFile(
      path,
      JSON.stringify({
        ...workerConfig,
        services: {
          bindings: [],
          grants: [],
          namespaces: ['retained.'],
          descriptors: [`${root}/retained-declaration.json`],
        },
      }),
    );
    const activated = await runNativeCommand({
      executable: process.execPath,
      args: [
        join(import.meta.dir, '../scripts/activate-service-policy.ts'),
        '--kind',
        'node',
        '--config',
        path,
        '--descriptor',
        descriptorPath,
        '--caller',
        'reader',
        '--read',
        'worker',
        '--socket',
        ownerSocket,
        '--endpoint',
        '/invoke',
        '--apply',
        'yes',
      ],
      envPolicy: 'ambient',
      capture: true,
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });
    if (activated.exitCode !== 0)
      throw new Error(`activation fixture failed: ${new TextDecoder().decode(activated.stderr)}`);
    workerConfig = NodeConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  }
  const worker = await startAgent(workerConfig);
  await waitConnected(reader, worker);
  const wire = createWireClient({ socketPath: `${root}/reader.sock` });
  const call = createServiceFetch(wire, {
    to: 'worker',
    descriptor,
    baseUrl: 'http://owner.invalid',
    ...(onTrace === undefined ? {} : { onTrace }),
  });
  return {
    ownerSocket,
    wire,
    policy: workerConfig.services,
    call,
    post: (path, signal, body = '{}') =>
      call(`http://owner.invalid${path}`, { method: 'POST', body, signal }),
    stop: async () => {
      wire.close();
      await reader.stop();
      await worker.stop();
      await broker.stop();
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}
