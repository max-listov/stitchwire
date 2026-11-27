import { afterAll, beforeAll, expect, test, spyOn } from 'bun:test';
import { EventSubscriptions } from '../packages/runtime/src/node/event-subscriptions.ts';
import { ServiceLane } from '../packages/runtime/src/service/lane.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceIngressSchema } from '../packages/contracts/src/service/contracts.ts';
import { ServiceDescriptorSchema } from '../packages/contracts/src/service/policy-schema.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { bindUnixSocket } from 'stitchkit/files';

/**
 * A node calling a service on ITSELF must not depend on a broker.
 *
 * Every agent here is configured with a broker endpoint that refuses connections, so any answer
 * other than a refusal proves the call never left the machine. That is the whole point: the shelf
 * the consumer measured was two round-trips to a broker on another continent, paid to reach a
 * socket in the next directory.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-service-loopback-'));
const socketPath = join(root, 'owner.sock');
const descriptorPath = join(root, 'descriptor.json');
const descriptor = ServiceDescriptorSchema.parse({
  service: 'test.local',
  revision: '3',
  maxInflight: 4,
  operations: [
    {
      id: 'window.read',
      path: '/local/window',
      effect: 'read',
      limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 },
      response: { kind: 'unary' },
    },
    {
      id: 'window.write',
      path: '/local/write',
      effect: 'write',
      limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 },
      response: { kind: 'unary' },
    },
  ],
});
/** Nothing listens here: reaching a broker at all is a failure of this fixture. */
const deadBroker = { id: 'nowhere', url: 'https://127.0.0.1:1/', token: 'x'.repeat(40) };
const binding = {
  service: 'test.local',
  descriptorPath,
  socketPath,
  endpointPath: '/invoke',
  maxInflight: 4,
  limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 },
};
let owner: ReturnType<typeof Bun.serve>;
let dispatches = 0;
const agents: Agent[] = [];
const shutdownEntered = Promise.withResolvers<void>();

function agentFor(input: {
  nodeId: string;
  serves?: boolean;
  grants: { caller: string; target: string; service: string; scope: unknown }[];
}): Agent {
  const agent = createAgent(
    NodeConfigSchema.parse({
      nodeId: input.nodeId,
      serves: input.serves ?? true,
      brokers: [deadBroker],
      services: { bindings: [binding], grants: input.grants },
    }),
  );
  agents.push(agent);
  return agent;
}

const readGrant = (node: string) => ({
  caller: node,
  target: node,
  service: 'test.local',
  scope: { kind: 'service-read' as const },
});

beforeAll(() => {
  writeFileSync(descriptorPath, JSON.stringify(descriptor));
  owner = bindUnixSocket({ path: socketPath, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      fetch: async (request) => {
        const call = ServiceIngressSchema.parse(await request.json());
        dispatches += 1;
        if (call.payload === '{"shutdown":true}') {
          shutdownEntered.resolve();
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{'));
              },
            }),
          );
        }
        return Response.json({ served: call.operation, caller: call.caller });
      },
    }),
  );
});

afterAll(async () => {
  await Promise.all(agents.map((agent) => agent.stop()));
  owner.stop(true);
  await rm(root, { recursive: true, force: true });
});

test('shutdown cancels lanes before waiting for subscriptions and drains loopback unary', async () => {
  const agent = agentFor({ nodeId: 'shutdown', grants: [readGrant('shutdown')] });
  const held = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const disconnect = spyOn(ServiceLane.prototype, 'disconnect');
  const subscriptions = spyOn(EventSubscriptions.prototype, 'drain').mockImplementation(async () => {
    entered.resolve();
    await held.promise;
  });
  try {
    const pending = agent.invokeService({
      to: 'shutdown',
      service: 'test.local',
      revision: '3',
      operation: 'window.read',
      payload: '{"shutdown":true}',
      timeoutMs: 5000,
    });
    await shutdownEntered.promise;
    const drained = agent.drainLocal();
    await entered.promise;
    expect(disconnect).toHaveBeenCalledWith('agent-shutdown');
    expect(await pending).toMatchObject({ cancellationOrigin: 'agent-shutdown', delivery: 'unknown' });
    held.resolve();
    await drained;
  } finally {
    held.resolve();
    subscriptions.mockRestore();
    disconnect.mockRestore();
    await agent.stop();
  }
});

test('a service call to this node is served locally while every broker is unreachable', async () => {
  const before = dispatches;
  const agent = agentFor({ nodeId: 'alone', grants: [readGrant('alone')] });
  const outcome = await agent.invokeService({
    to: 'alone',
    service: 'test.local',
    revision: '3',
    operation: 'window.read',
    payload: '{}',
    timeoutMs: 5000,
  });
  expect(outcome.status).toBe('response');
  if (outcome.status !== 'response') throw new Error('unreachable');
  expect(outcome.httpStatus).toBe(200);
  expect(JSON.parse(outcome.payload)).toEqual({ served: 'window.read', caller: 'alone' });
  // The owner really ran it, and it was attributed to this node rather than to an anonymous door.
  expect(dispatches).toBe(before + 1);
});

test('the shortcut still asks the node policy: an ungranted operation is denied, not served', async () => {
  const before = dispatches;
  const agent = agentFor({ nodeId: 'reader', grants: [readGrant('reader')] });
  const outcome = await agent.invokeService({
    to: 'reader',
    service: 'test.local',
    revision: '3',
    // `service-read` covers reads only; a write must still be granted by name.
    operation: 'window.write',
    payload: '{}',
    timeoutMs: 5000,
  });
  expect(outcome).toMatchObject({ status: 'failure', code: 'denied' });
  expect(dispatches).toBe(before);
});

test('a node with no grant of its own is denied by itself, not admitted by proximity', async () => {
  const before = dispatches;
  const agent = agentFor({ nodeId: 'ungranted', grants: [] });
  const outcome = await agent.invokeService({
    to: 'ungranted',
    service: 'test.local',
    revision: '3',
    operation: 'window.read',
    payload: '{}',
    timeoutMs: 5000,
  });
  expect(outcome).toMatchObject({ status: 'failure', code: 'denied' });
  expect(dispatches).toBe(before);
});

test('a call addressed elsewhere still needs a broker and says so', async () => {
  const agent = agentFor({ nodeId: 'router', grants: [readGrant('router')] });
  const outcome = await agent.invokeService({
    to: 'somewhere-else',
    service: 'test.local',
    revision: '3',
    operation: 'window.read',
    payload: '{}',
    timeoutMs: 1500,
  });
  expect(outcome).toMatchObject({ status: 'failure', delivery: 'not-dispatched' });
});

test('a node that declares it does not serve keeps the old path for its own calls', async () => {
  const before = dispatches;
  const agent = agentFor({ nodeId: 'quiet', serves: false, grants: [readGrant('quiet')] });
  const outcome = await agent.invokeService({
    to: 'quiet',
    service: 'test.local',
    revision: '3',
    operation: 'window.read',
    payload: '{}',
    timeoutMs: 1500,
  });
  // The broker is what refuses a non-serving target, and no broker is reachable here — so the
  // answer is a transport refusal, never a local success.
  expect(outcome.status).toBe('failure');
  expect(dispatches).toBe(before);
});
