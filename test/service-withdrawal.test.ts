import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceIngressSchema } from '../packages/contracts/src/service/contracts.ts';
import { ServiceDescriptorSchema } from '../packages/contracts/src/service/policy-schema.ts';
import type { BrokerHandle } from '../packages/runtime/src/broker/contracts.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { brokerConfig, brokerLane, CALL_POLL_MS, freePort, until, waitConnected } from './support.ts';
import { bindUnixSocket } from 'stitchkit/files';

/**
 * What a caller hears from a service its owner took back, through a broker.
 *
 * Two answers exist and they come from two places. A broker that holds no grant for the call answers
 * `denied`, a policy refusal, and the node never sees it. A node that is granted the call but does not
 * serve that service answers `unsupported`. A withdrawn declared service loses its grants together
 * with its binding, so its settled answer is the broker's — also when the withdrawal is an agent
 * that starts with nothing bound at all, which has no file left to poll and still owes every broker
 * the empty declaration.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-service-withdrawal-'));
const TOKEN_SERVER = 's'.repeat(40);
const TOKEN_READER = 'r'.repeat(40);
const NAMESPACE = 'owner.';
const SERVICE = 'owner.window';
/** Granted to the reader by the broker's configuration and bound on no node. */
const UNSERVED = 'fleet.absent';
/** How often the declaration file is re-read here; a node polls every five seconds. */
const POLL_MS = 100;
const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 };

const agents: Agent[] = [];
let broker: BrokerHandle | undefined;
let owner: ReturnType<typeof Bun.serve> | undefined;

afterAll(async () => {
  await Promise.all(agents.map((agent) => agent.stop()));
  await broker?.stop();
  owner?.stop(true);
  await rm(root, { recursive: true, force: true });
});

test('a withdrawn service answers denied before dispatch, also after its agent restarts with nothing bound', async () => {
  const port = freePort();
  broker = await startBroker(
    brokerConfig(
      { server: TOKEN_SERVER, reader: TOKEN_READER },
      {
        port,
        serviceNamespaces: { server: [NAMESPACE] },
        serviceGrants: [
          { caller: 'reader', target: 'server', service: UNSERVED, scope: { kind: 'service-read' } },
        ],
      },
    ),
  );

  const socketPath = join(root, 'owner.sock');
  const descriptorPath = join(root, 'descriptor.json');
  const declarationPath = join(root, 'declaration.json');
  writeFileSync(
    descriptorPath,
    JSON.stringify(
      ServiceDescriptorSchema.parse({
        service: SERVICE,
        revision: '1',
        maxInflight: 4,
        operations: [
          { id: 'window.read', path: '/window', effect: 'read', limits, response: { kind: 'unary' } },
        ],
      }),
    ),
  );
  const reached: string[] = [];
  owner = bindUnixSocket({ path: socketPath, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      fetch: async (request) => {
        const call = ServiceIngressSchema.parse(await request.json());
        reached.push(call.operation);
        return Response.json({ served: call.operation });
      },
    }),
  );
  const install = () =>
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
        },
        callers: [{ caller: 'reader', scope: { kind: 'service-read' } }],
      }),
    );

  const startServer = async (descriptors: string[]) => {
    const agent = createAgent(
      NodeConfigSchema.parse({
        nodeId: 'server',
        brokers: brokerLane(port, TOKEN_SERVER),
        services: { bindings: [], grants: [], namespaces: [NAMESPACE], descriptors },
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { declarationPollMs: POLL_MS },
    );
    agents.push(agent);
    await waitConnected(agent);
    return agent;
  };
  const client = createAgent(
    NodeConfigSchema.parse({ nodeId: 'reader', brokers: brokerLane(port, TOKEN_READER) }),
  );
  agents.push(client);
  await waitConnected(client);

  const invoke = (service: string) =>
    client.invokeService({
      to: 'server',
      service,
      revision: '1',
      operation: 'window.read',
      payload: '{}',
      timeoutMs: 3_000,
    });
  let last: unknown = null;
  const served = async () => {
    last = await invoke(SERVICE);
    return (last as { status: string }).status === 'response';
  };
  /** The broker's own refusal: no grant, so no node was asked. */
  const denied = async () => {
    const outcome = await invoke(SERVICE);
    last = outcome;
    return (
      outcome.status === 'failure' &&
      outcome.code === 'denied' &&
      outcome.refusal === 'policy' &&
      outcome.delivery === 'not-dispatched'
    );
  };
  const explain = (what: string) => new Error(`${what}: ${JSON.stringify(last)}`);

  install();
  let server = await startServer([declarationPath]);
  if (!(await until(served, 12_000, CALL_POLL_MS))) throw explain('not served');

  // The control: a call the broker's configuration grants reaches the node, and a node that serves
  // no such service answers `unsupported`. Its absence is the node's fact, not a policy refusal.
  const unserved = await invoke(UNSERVED);
  expect(unserved).toMatchObject({ status: 'failure', code: 'unsupported', refusal: 'none' });

  // The owner deletes the declaration under a running agent: binding and grants leave in one poll.
  rmSync(declarationPath);
  if (!(await until(denied, 12_000, CALL_POLL_MS))) throw explain('a deleted declaration is not denied');
  install();
  if (!(await until(served, 12_000, CALL_POLL_MS))) throw explain('not served again');

  // An installer unbinds the descriptor and restarts the agent. The new process has no file to poll,
  // and the broker still holds the grants the previous process declared: only the empty declaration
  // takes them back. Without it the call would be routed and answered `unsupported` by the node.
  await server.stop();
  rmSync(declarationPath);
  reached.length = 0;
  server = await startServer([]);
  if (!(await until(denied, 12_000, CALL_POLL_MS))) throw explain('a restarted empty agent is not denied');
  expect((await server.status()).services.declarations.lanes[0]).toMatchObject({ accepted: 0, refused: [] });
  // Settled, not a passing state: the answer stays the broker's and the owner is never reached.
  expect(await denied()).toBe(true);
  expect(reached).toEqual([]);
  // The configured grant is untouched by the withdrawal and still reaches the node.
  expect(await invoke(UNSERVED)).toMatchObject({ status: 'failure', code: 'unsupported' });
}, 90_000);
