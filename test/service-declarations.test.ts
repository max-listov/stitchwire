import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceIngressSchema } from '../packages/contracts/src/service/contracts.ts';
import { ServiceDeclareSchema } from '../packages/contracts/src/service/declaration.ts';
import { ServiceDescriptorSchema } from '../packages/contracts/src/service/policy-schema.ts';
import type { BrokerHandle } from '../packages/runtime/src/broker/contracts.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { ServiceGrantRegistry } from '../packages/runtime/src/service/grant-registry.ts';
import { brokerConfig, brokerLane, CALL_POLL_MS, freePort, until, waitConnected } from './support.ts';
import { bindUnixSocket } from 'stitchkit/files';

/**
 * An owner serves a service and names who may call it by editing its own declaration, and nobody
 * else touches anything.
 *
 * The fleet grants a node a service namespace; the node reads the declaration its owner installed,
 * serves the binding and tells each broker who may call. These tests hold the borders that make that
 * safe — a node grants calls only to itself, only inside its namespace, and a declaration replaces
 * the previous one whole — and the property that makes it self-service: a new service and a new
 * reader work across nodes with no configuration edit and no restart.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-service-declarations-'));
const TOKEN_SERVER = 's'.repeat(40);
const TOKEN_READER = 'r'.repeat(40);
const TOKEN_OTHER = 'o'.repeat(40);
const TOKEN_STRANGER = 'x'.repeat(40);
const NAMESPACE = 'owner.';
/** How often the declaration files are re-read here; a node polls every five seconds. */
const POLL_MS = 100;
const TOKENS = { server: TOKEN_SERVER, reader: TOKEN_READER, other: TOKEN_OTHER, stranger: TOKEN_STRANGER };
const nodes = Object.entries(TOKENS).map(([id, token]) => ({ id, tokenSha256s: [sha256(token)] }));

// Every stand lives under one directory; it goes once, after the last of them.
afterAll(() => rm(root, { recursive: true, force: true }));

function serviceBroker(port: number) {
  return brokerConfig(TOKENS, { port, serviceNamespaces: { server: [NAMESPACE] } });
}

function refusal(overrides: Record<string, unknown>): string {
  const parsed = BrokerConfigSchema.safeParse({ nodes, ...overrides });
  return parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join('\n');
}

const readGrant = (target: string, service: string, caller = 'reader') => ({
  caller,
  target,
  service,
  scope: { kind: 'service-read' as const },
});

describe('configuration names each service namespace to a registered node', () => {
  test('an unregistered node, a prefix without its dot and a repeated prefix are refused', () => {
    expect(refusal({ serviceNamespaces: { ghost: [NAMESPACE] } })).toContain('node is not registered');
    expect(refusal({ serviceNamespaces: { server: ['owner'] } })).not.toBe('');
    expect(refusal({ serviceNamespaces: { server: [NAMESPACE, NAMESPACE] } })).toContain('unique');
    // One owner runs the same service on many machines: the prefix may repeat across nodes.
    expect(refusal({ serviceNamespaces: { server: [NAMESPACE], other: [NAMESPACE] } })).toBe('');
  });
});

describe('a broker judges each declared grant on its own', () => {
  test('a node grants calls only to itself and only inside its namespaces', () => {
    const registry = new ServiceGrantRegistry(serviceBroker(1));
    const ack = registry.declare(
      'server',
      ServiceDeclareSchema.parse({
        target: 'server',
        grants: [
          readGrant('server', 'owner.window'),
          readGrant('server', 'elsewhere.window'),
          readGrant('other', 'owner.window'),
        ],
      }),
    );
    expect(ack.accepted).toBe(1);
    const reasons = ack.refused.map((entry) => entry.detail);
    expect(reasons.some((detail) => detail.includes('outside the service namespaces'))).toBe(true);
    expect(reasons.some((detail) => detail.includes('only to itself'))).toBe(true);
    expect(registry.grants()).toEqual([readGrant('server', 'owner.window')]);
  });

  test('a node cannot declare for another, and a later declaration replaces the earlier one whole', () => {
    const registry = new ServiceGrantRegistry(serviceBroker(1));
    const spoof = registry.declare(
      'reader',
      ServiceDeclareSchema.parse({ target: 'server', grants: [readGrant('server', 'owner.window')] }),
    );
    expect(spoof.accepted).toBe(0);
    expect(spoof.refused[0]?.detail).toContain('does not match the authenticated socket');
    expect(registry.grants()).toEqual([]);

    registry.declare(
      'server',
      ServiceDeclareSchema.parse({ target: 'server', grants: [readGrant('server', 'owner.a')] }),
    );
    registry.declare(
      'server',
      ServiceDeclareSchema.parse({ target: 'server', grants: [readGrant('server', 'owner.b')] }),
    );
    expect(registry.grants()).toEqual([readGrant('server', 'owner.b')]);
    registry.declare('server', ServiceDeclareSchema.parse({ target: 'server', grants: [] }));
    expect(registry.grants()).toEqual([]);
  });
});

describe('an owner adds a service and its reader by editing its own declaration', () => {
  const agents: Agent[] = [];
  let broker: BrokerHandle | undefined;
  let owner: ReturnType<typeof Bun.serve> | undefined;

  afterAll(async () => {
    await Promise.all(agents.map((agent) => agent.stop()));
    await broker?.stop();
    owner?.stop(true);
  });

  test('declared services are served across nodes without a restart, and return after the broker restarts', async () => {
    const port = freePort();
    const config = serviceBroker(port);
    broker = await startBroker(config);

    const socketPath = join(root, 'owner.sock');
    const descriptorPath = join(root, 'descriptor.json');
    writeFileSync(
      descriptorPath,
      JSON.stringify(
        ServiceDescriptorSchema.parse({
          service: 'owner.window',
          revision: '1',
          maxInflight: 4,
          operations: [
            {
              id: 'window.read',
              path: '/window',
              effect: 'read',
              limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 },
              response: { kind: 'unary' },
            },
            {
              id: 'window.watch',
              path: '/window/watch',
              effect: 'read',
              limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 },
              response: { kind: 'stream', lifetimeMs: 5000 },
            },
          ],
        }),
      ),
    );
    owner = bindUnixSocket({ path: socketPath, mode: 0o600 }, (unix) =>
      Bun.serve({
        unix,
        fetch: async (request) => {
          const call = ServiceIngressSchema.parse(await request.json());
          if (call.operation === 'window.watch') return new Response('frame\n');
          return Response.json({ served: call.operation, caller: call.caller });
        },
      }),
    );

    const declarationPath = join(root, 'owner.window.json');
    // Not named `declare`: at the start of a statement Bun's transpiler reads that as an ambient
    // TypeScript declaration and drops the whole call, so the file would never be written.
    const writeDeclaration = (service: string, callers: unknown[]) =>
      writeFileSync(
        declarationPath,
        JSON.stringify({
          binding: {
            service,
            descriptorPath,
            socketPath,
            endpointPath: '/invoke',
            maxInflight: 4,
            limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 },
          },
          callers,
        }),
      );
    const reader = { caller: 'reader', scope: { kind: 'service-read' } };

    const server = createAgent(
      NodeConfigSchema.parse({
        nodeId: 'server',
        brokers: brokerLane(port, TOKEN_SERVER),
        services: { bindings: [], grants: [], namespaces: [NAMESPACE], descriptors: [declarationPath] },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { declarationPollMs: POLL_MS },
    );
    const client = createAgent(
      NodeConfigSchema.parse({ nodeId: 'reader', brokers: brokerLane(port, TOKEN_READER) }),
    );
    agents.push(server, client);
    await waitConnected(server, client);

    const invoke = () =>
      client.invokeService({
        to: 'server',
        service: 'owner.window',
        revision: '1',
        operation: 'window.read',
        payload: '{}',
        timeoutMs: 3_000,
      });
    let last: unknown = null;
    const served = async () => {
      const outcome = await invoke();
      last = outcome;
      return outcome.status === 'response';
    };
    const denied = async () => {
      const outcome = await invoke();
      return outcome.status === 'failure' && outcome.code === 'denied';
    };

    // Nothing is declared yet: the broker has no grant, so the call is refused before dispatch.
    expect(await denied()).toBe(true);

    // The owner writes one file: the binding and its reader. No configuration edit, no restart.
    writeDeclaration('owner.window', [reader]);
    if (!(await until(served, 12_000, CALL_POLL_MS)))
      throw new Error(`not served: ${JSON.stringify({ last, services: (await server.status()).services })}`);
    const outcome = await invoke();
    if (outcome.status !== 'response') throw new Error('expected a served response');
    expect(JSON.parse(outcome.payload)).toEqual({ served: 'window.read', caller: 'reader' });
    const status = await server.status();
    expect(status.services.namespaces).toEqual([NAMESPACE]);
    expect(status.services.declarations.descriptors[0]).toMatchObject({
      state: 'loaded',
      service: 'owner.window',
      callers: 1,
    });
    expect(status.services.declarations.lanes[0]).toMatchObject({
      lane: 'primary',
      accepted: 1,
      refused: [],
    });

    // A stream of the same declared service is admitted by the same declared grant: the broker reads
    // one live table for unary calls and streams alike, not the configured grants alone.
    const streamed = client.openStream({
      to: 'server',
      source: {
        kind: 'service',
        service: 'owner.window',
        revision: '1',
        operation: 'window.watch',
        payload: '{}',
      },
      timeoutMs: 3_000,
    });
    const first = (await streamed.next()).value as Record<string, unknown> | undefined;
    await streamed.return?.(undefined);
    expect(first?.refusal === 'policy').toBe(false);
    const audited = await until(() => {
      try {
        return readFileSync(config.auditPath, 'utf8')
          .split('\n')
          .filter(Boolean)
          .some((line) => {
            const event = JSON.parse(line).event;
            return (
              event?.kind === 'stream-open' &&
              event.subject === 'owner.window:window.watch' &&
              event.accepted === true
            );
          });
      } catch {
        return false;
      }
    }, 5_000);
    if (!audited) throw new Error(`stream not admitted: ${JSON.stringify(first)}`);

    // Taking the reader away is the same kind of edit, and the broker stops routing the call.
    writeDeclaration('owner.window', []);
    expect(await until(denied, 12_000, CALL_POLL_MS)).toBe(true);

    // A service outside the namespace the fleet granted is refused on the node, before any broker.
    writeDeclaration('elsewhere.window', [reader]);
    expect(
      await until(async () => {
        const refused = (await server.status()).services.declarations.refused;
        return refused.some((entry) => entry.service === 'elsewhere.window');
      }, 12_000),
    ).toBe(true);

    // A restarted broker knows no declared grant; the node's reconnect tells it again.
    writeDeclaration('owner.window', [reader]);
    expect(await until(served, 12_000, CALL_POLL_MS)).toBe(true);

    // A file that stops parsing fails closed: its previous version's grants go with it, and the
    // node says why instead of serving what it last read.
    writeFileSync(declarationPath, '{ not json');
    expect(await until(denied, 12_000, CALL_POLL_MS)).toBe(true);
    expect((await server.status()).services.declarations.descriptors[0]).toMatchObject({ state: 'invalid' });
    writeDeclaration('owner.window', [reader]);
    expect(await until(served, 12_000, CALL_POLL_MS)).toBe(true);

    await broker.stop();
    broker = await startBroker(config);
    expect(await until(served, 15_000, CALL_POLL_MS)).toBe(true);
  }, 90_000);
});

describe('declared callers hold exactly the scope their owner wrote', () => {
  const agents: Agent[] = [];
  const stands = join(root, 'scopes');
  let broker: BrokerHandle | undefined;
  let owner: ReturnType<typeof Bun.serve> | undefined;
  const LARGE = 1_000_000;

  afterAll(async () => {
    await Promise.all(agents.map((agent) => agent.stop()));
    await broker?.stop();
    owner?.stop(true);
  });

  test('a read scope admits reads only, an operation scope its operation only, and a stranger nothing', async () => {
    // The owner socket's directory must be private for the node to dial it.
    mkdirSync(stands, { recursive: true, mode: 0o700 });
    const port = freePort();
    broker = await startBroker(serviceBroker(port));
    const descriptorPath = join(stands, 'descriptor.json');
    const limits = { requestBytes: 1_048_576, responseBytes: 1_048_576, timeoutMs: 5000 };
    writeFileSync(
      descriptorPath,
      JSON.stringify(
        ServiceDescriptorSchema.parse({
          service: 'owner.notify',
          revision: '1',
          maxInflight: 4,
          operations: [
            { id: 'notify.read', path: '/notify', effect: 'read', limits, response: { kind: 'unary' } },
            {
              id: 'notify.launch',
              path: '/notify/launch',
              effect: 'write',
              limits,
              response: { kind: 'unary' },
            },
          ],
        }),
      ),
    );
    const socketPath = join(stands, 'owner.sock');
    const reached: string[] = [];
    owner = bindUnixSocket({ path: socketPath, mode: 0o600 }, (unix) =>
      Bun.serve({
        unix,
        fetch: async (request) => {
          const call = ServiceIngressSchema.parse(await request.json());
          reached.push(`${call.caller}:${call.operation}`);
          return Response.json({ echo: 'x'.repeat(LARGE) });
        },
      }),
    );
    const declarationPath = join(stands, 'declaration.json');
    writeFileSync(
      declarationPath,
      JSON.stringify({
        binding: {
          service: 'owner.notify',
          descriptorPath,
          socketPath,
          endpointPath: '/invoke',
          maxInflight: 4,
          limits,
        },
        callers: [
          { caller: 'reader', scope: { kind: 'service-read' } },
          { caller: 'other', scope: { kind: 'operation', operation: 'notify.launch' } },
        ],
      }),
    );
    const server = createAgent(
      NodeConfigSchema.parse({
        nodeId: 'server',
        brokers: brokerLane(port, TOKEN_SERVER),
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
      NodeConfigSchema.parse({ nodeId: 'reader', brokers: brokerLane(port, TOKEN_READER) }),
    );
    const operator = createAgent(
      NodeConfigSchema.parse({ nodeId: 'other', brokers: brokerLane(port, TOKEN_OTHER) }),
    );
    const stranger = createAgent(
      NodeConfigSchema.parse({ nodeId: 'stranger', brokers: brokerLane(port, TOKEN_STRANGER) }),
    );
    agents.push(server, reader, operator, stranger);
    await waitConnected(server, reader, operator, stranger);

    const invoke = (agent: Agent, operation: string, payload = '{}') =>
      agent.invokeService({
        to: 'server',
        service: 'owner.notify',
        revision: '1',
        operation,
        payload,
        timeoutMs: 4_000,
      });
    let last: unknown = null;
    const served = async () => {
      const outcome = await invoke(reader, 'notify.read');
      last = outcome;
      return outcome.status === 'response';
    };
    if (!(await until(served, 12_000, CALL_POLL_MS)))
      throw new Error(`not served: ${JSON.stringify({ last, services: (await server.status()).services })}`);
    // The controls: each refusal is the node's answer, before the owner, not a timeout.
    const refusedWithoutDispatch = (outcome: Awaited<ReturnType<typeof invoke>>) =>
      outcome.status === 'failure' && outcome.code === 'denied' && outcome.delivery === 'not-dispatched';
    reached.length = 0;
    expect(refusedWithoutDispatch(await invoke(reader, 'notify.launch'))).toBe(true);
    expect(refusedWithoutDispatch(await invoke(operator, 'notify.read'))).toBe(true);
    // A registered node the declaration does not name holds no scope at all.
    expect(refusedWithoutDispatch(await invoke(stranger, 'notify.read'))).toBe(true);
    expect(refusedWithoutDispatch(await invoke(stranger, 'notify.launch'))).toBe(true);
    expect(reached).toEqual([]);
    expect((await invoke(operator, 'notify.launch')).status).toBe('response');
    expect(reached).toEqual(['other:notify.launch']);

    // A document and an answer near the 1 MiB ceilings cross the declared door both ways.
    const document = JSON.stringify({ text: 'a'.repeat(LARGE) });
    const large = await invoke(reader, 'notify.read', document);
    if (large.status !== 'response') throw new Error(`large exchange failed: ${JSON.stringify(large)}`);
    expect(JSON.parse(large.payload).echo).toHaveLength(LARGE);
    expect(reached.at(-1)).toBe('reader:notify.read');
  }, 60_000);
});
