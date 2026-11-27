import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceIngressSchema } from '../packages/contracts/src/service/contracts.ts';
import type { BrokerHandle } from '../packages/runtime/src/broker/contracts.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { brokerConfig, brokerLane, CALL_POLL_MS, freePort, until, waitConnected } from './support.ts';
import { bindUnixSocket } from 'stitchkit/files';

const NAMESPACE = 'owner.';
const SERVICE = 'owner.catalog';
const SERVER_TOKEN = 's'.repeat(40);
const READER_TOKEN = 'r'.repeat(40);
/** How often the declaration file is re-read here; a node polls every five seconds. */
const POLL_MS = 100;

const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 };
export const catalogOperation = (id: string, path: string, effect: 'read' | 'write') => ({
  id,
  path,
  effect,
  limits,
  response: { kind: 'unary' as const },
});

/** A descriptor document of the service this stand serves; `operations` is whatever the test wants on disk. */
export const catalogDescriptor = (operations: ReturnType<typeof catalogOperation>[]) => ({
  service: SERVICE,
  revision: '1',
  maxInflight: 4,
  operations,
});

/**
 * One owner behind a node, a broker, and a reader node that holds the read scope: the owner's
 * descriptor and declaration are files the test rewrites, exactly as an owner's installer would.
 * `reached` lists every call that got through the node to the owner's socket.
 */
export interface ServiceStand {
  readonly reached: string[];
  readonly server: Agent;
  readonly dir: string;
  readonly descriptorPath: string;
  writeDescriptor(content: unknown): void;
  /** Writes the declaration; `callers` defaults to the reader holding the read scope. */
  writeDeclaration(binding?: Record<string, unknown>, callers?: unknown[]): void;
  /** Writes raw bytes to the declaration path: for text that is not a declaration at all. */
  writeDeclarationBytes(bytes: Uint8Array | string): void;
  invoke(operation: string): ReturnType<Agent['invokeService']>;
  /** Waits until the reader's call to `operation` is answered by the owner. */
  served(operation: string): Promise<boolean>;
  stop(): Promise<void>;
}

export async function startServiceStand(): Promise<ServiceStand> {
  const dir = mkdtempSync(join(tmpdir(), 'wire-stand-'));
  const port = freePort();
  const broker: BrokerHandle = await startBroker(
    brokerConfig(
      { server: SERVER_TOKEN, reader: READER_TOKEN },
      { port, serviceNamespaces: { server: [NAMESPACE] } },
    ),
  );
  const socketPath = join(dir, 'owner.sock');
  const descriptorPath = join(dir, 'descriptor.json');
  const declarationPath = join(dir, 'declaration.json');
  const reached: string[] = [];
  const owner = bindUnixSocket({ path: socketPath, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      fetch: async (request) => {
        const call = ServiceIngressSchema.parse(await request.json());
        reached.push(`${new URL(request.url).pathname}:${call.operation}`);
        return Response.json({ served: call.operation });
      },
    }),
  );
  const server = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'server',
      brokers: brokerLane(port, SERVER_TOKEN),
      services: { bindings: [], grants: [], namespaces: [NAMESPACE], descriptors: [declarationPath] },
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { declarationPollMs: POLL_MS },
  );
  const reader = createAgent(
    NodeConfigSchema.parse({ nodeId: 'reader', brokers: brokerLane(port, READER_TOKEN) }),
  );
  await waitConnected(server, reader);
  const invoke = (operation: string) =>
    reader.invokeService({
      to: 'server',
      service: SERVICE,
      revision: '1',
      operation,
      payload: '{}',
      timeoutMs: 3_000,
    });
  return {
    reached,
    server,
    dir,
    descriptorPath,
    writeDescriptor: (content) =>
      writeFileSync(descriptorPath, typeof content === 'string' ? content : JSON.stringify(content)),
    writeDeclaration: (binding = {}, callers = [{ caller: 'reader', scope: { kind: 'service-read' } }]) =>
      writeFileSync(
        declarationPath,
        JSON.stringify({
          binding: {
            service: SERVICE,
            descriptorPath,
            socketPath,
            endpointPath: '/invoke',
            maxInflight: 4,
            limits,
            ...binding,
          },
          callers,
        }),
      ),
    writeDeclarationBytes: (bytes) => writeFileSync(declarationPath, bytes),
    invoke,
    served: (operation) =>
      until(async () => (await invoke(operation)).status === 'response', 12_000, CALL_POLL_MS),
    stop: async () => {
      await Promise.all([server.stop(), reader.stop()]);
      await broker.stop();
      owner.stop(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
