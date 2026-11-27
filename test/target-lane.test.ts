import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticJournalFrameSchema } from 'stitchkit/application';
import { AuditRecordSchema } from '../packages/runtime/src/broker/audit-schema.ts';
import { LocalCallSchema, LocalStreamRequestSchema } from '../packages/contracts/src/door/requests.ts';
import { ServiceIngressSchema } from '../packages/contracts/src/service/contracts.ts';
import { ServiceDescriptorSchema } from '../packages/contracts/src/service/policy-schema.ts';
import type { BrokerHandle } from '../packages/runtime/src/broker/contracts.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { brokerConfig, freePort, until } from './support.ts';
import { bindUnixSocket } from 'stitchkit/files';

const root = mkdtempSync(join(tmpdir(), 'wire-target-lane-'));
const callerToken = 'c'.repeat(40);
const targetToken = 't'.repeat(40);
const policyToken = 'p'.repeat(40);
const serviceTargetToken = 's'.repeat(40);
const serviceSocket = join(root, 'owner.sock');
const descriptorPath = join(root, 'descriptor.json');
const serviceDescriptor = ServiceDescriptorSchema.parse({
  service: 'test.echo',
  revision: '1',
  maxInflight: 8,
  operations: [
    {
      id: 'read',
      path: '/echo/read',
      effect: 'read',
      limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 },
      response: { kind: 'unary' },
    },
  ],
});
const serviceGrant = {
  caller: 'caller',
  target: 'service-target',
  service: 'test.echo',
  scope: { kind: 'service-read' as const },
};
const brokers: BrokerHandle[] = [];
const endpoints: { id: string; url: string; token: string }[] = [];
let caller: Agent;
let target: Agent;
let serviceTarget: Agent;
let serviceTargetStopped = false;
let serviceDispatches = 0;
let owner: ReturnType<typeof Bun.serve>;

function startTarget(lane: number, serves = true): Agent {
  const endpoint = endpoints[lane];
  if (endpoint === undefined) throw new Error('missing test lane');
  return createAgent(
    NodeConfigSchema.parse({
      nodeId: 'target',
      serves,
      brokers: [{ ...endpoint, token: targetToken }],
      allow: {
        echo: {
          bin: '/bin/echo',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
        sleep: {
          bin: '/bin/sleep',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
      },
      streams: { echo: { bin: '/bin/echo' } },
    }),
  );
}

beforeAll(async () => {
  writeFileSync(descriptorPath, JSON.stringify(serviceDescriptor));
  owner = bindUnixSocket({ path: serviceSocket, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      fetch: async (request) => {
        const call = ServiceIngressSchema.parse(await request.json());
        serviceDispatches += 1;
        return new Response(call.payload, { headers: { 'content-type': 'application/json' } });
      },
    }),
  );
  for (const id of ['left', 'right']) {
    const broker = await startBroker(
      brokerConfig(
        {
          caller: callerToken,
          target: targetToken,
          policy: policyToken,
          'service-target': serviceTargetToken,
        },
        {
          port: freePort(),
          capabilities: {
            caller: [
              { operation: 'peer', targets: ['target'] },
              { operation: 'stream', targets: ['target'] },
            ],
            ...(id === 'right'
              ? {
                  policy: [
                    { operation: 'peer', targets: ['target'] },
                    { operation: 'stream', targets: ['target'] },
                  ],
                }
              : {}),
          },
          // The asymmetry is the point of this fixture: only the RIGHT broker grants `policy`.
          // A caller denied on one lane must not find a wider grant by trying the other.
          commandGrants: [
            { caller: 'caller', targets: ['target'], command: 'echo' },
            { caller: 'caller', targets: ['target'], command: 'sleep' },
            ...(id === 'right'
              ? [
                  { caller: 'policy', targets: ['target'], command: 'echo' },
                  { caller: 'policy', targets: ['target'], command: 'sleep' },
                ]
              : []),
          ],
          serviceGrants: [serviceGrant],
          auditPath: join(root, `${id}.jsonl`),
        },
      ),
    );
    brokers.push(broker);
    endpoints.push({ id, url: `http://127.0.0.1:${broker.port}`, token: callerToken });
  }
  caller = createAgent(NodeConfigSchema.parse({ nodeId: 'caller', brokers: endpoints }));
  target = startTarget(1);
  serviceTarget = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'service-target',
      brokers: endpoints.map((endpoint) => ({ ...endpoint, token: serviceTargetToken })),
      services: {
        bindings: [
          {
            service: 'test.echo',
            descriptorPath,
            socketPath: serviceSocket,
            endpointPath: '/v1/service',
            maxInflight: 8,
            limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 },
          },
        ],
        grants: [serviceGrant],
      },
    }),
  );
  expect(
    await until(
      async () =>
        (await caller.status()).lanes.every((lane) => lane.connected) &&
        (await caller.status()).nodes.some((node) => node.nodeId === 'target' && node.serves) &&
        (await caller.status()).nodes.some((node) => node.nodeId === 'service-target' && node.serves),
    ),
  ).toBe(true);
});

afterAll(async () => {
  await caller?.stop();
  await target?.stop();
  if (!serviceTargetStopped) await serviceTarget?.stop();
  await Promise.all(brokers.map((broker) => broker.stop()));
  owner?.stop(true);
});

const call = () => caller.call({ to: 'target', argv: ['echo', 'single-home'], stdin: null });
async function stream() {
  const frames = [];
  for await (const frame of caller.openStream({
    to: 'target',
    profile: 'echo',
    args: [],
    stdin: null,
    cursor: null,
  }))
    frames.push(frame);
  return frames;
}

const service = () =>
  caller.invokeService({
    to: 'service-target',
    service: 'test.echo',
    revision: '1',
    operation: 'read',
    payload: '{"value":"multi-home"}',
    timeoutMs: 3000,
  });

test('healthy multi-home caller always uses the single serving target lane for RPC and streams', async () => {
  for (let i = 0; i < 8; i += 1)
    expect(await call()).toMatchObject({ failure: 'none', stdout: 'single-home\n' });
  for (let i = 0; i < 4; i += 1) expect((await stream()).at(-1)).toMatchObject({ reason: 'completed' });
});

test('service dispatch is node-level across two serving target lanes', async () => {
  const before = serviceDispatches;
  for (let index = 0; index < 4; index += 1) {
    expect(await service()).toMatchObject({
      status: 'response',
      delivery: 'received',
      payload: '{"value":"multi-home"}',
    });
  }
  expect(serviceDispatches - before).toBe(4);
});

test('loss, non-serving presence and target reconnect on the other broker change the route', async () => {
  await target.stop();
  expect(
    await until(
      async () => !(await caller.status()).nodes.some((node) => node.nodeId === 'target' && node.serves),
    ),
  ).toBe(true);
  expect(await call()).toMatchObject({ failure: 'offline', transportCause: 'target-offline' });
  expect((await stream()).at(-1)).toMatchObject({
    failure: 'offline',
    transportCause: 'target-offline',
  });
  target = startTarget(1, false);
  expect(
    await until(async () =>
      (await caller.status()).nodes.some((node) => node.nodeId === 'target' && node.online && !node.serves),
    ),
  ).toBe(true);
  expect(await call()).toMatchObject({ failure: 'offline', transportCause: 'target-offline' });
  await target.stop();
  target = startTarget(0);
  expect(
    await until(async () =>
      (await caller.status()).nodes.some((node) => node.nodeId === 'target' && node.serves),
    ),
  ).toBe(true);
  for (let i = 0; i < 4; i += 1) expect(await call()).toMatchObject({ failure: 'none' });
  expect((await stream()).at(-1)).toMatchObject({ reason: 'completed' });
});

test('a settled RPC removes its caller abort listener', async () => {
  const controller = new AbortController();
  const added = controller.signal.addEventListener.bind(controller.signal);
  const removed = controller.signal.removeEventListener.bind(controller.signal);
  let active = 0;
  Object.defineProperties(controller.signal, {
    addEventListener: {
      value: (...args: Parameters<AbortSignal['addEventListener']>) => {
        if (args[0] === 'abort') active += 1;
        return added(...args);
      },
    },
    removeEventListener: {
      value: (...args: Parameters<AbortSignal['removeEventListener']>) => {
        if (args[0] === 'abort') active -= 1;
        return removed(...args);
      },
    },
  });
  expect(
    await caller.call({ to: 'target', argv: ['echo', 'listener'], stdin: null }, controller.signal),
  ).toMatchObject({ failure: 'none' });
  expect(active).toBe(0);
});

test('routing does not weaken node policy, broker default-deny or caller-selector rejection', async () => {
  expect(await caller.call({ to: 'target', argv: ['undeclared'], stdin: null })).toMatchObject({
    failure: 'denied',
    refusal: 'policy',
  });
  expect(await target.call({ to: 'caller', argv: ['echo'], stdin: null })).toMatchObject({
    failure: 'denied',
    refusal: 'policy',
  });
  for (const field of ['lane', 'broker', 'url', 'path', 'shell']) {
    expect(LocalCallSchema.safeParse({ to: 'target', argv: ['echo'], [field]: 'arbitrary' }).success).toBe(
      false,
    );
    expect(
      LocalStreamRequestSchema.safeParse({ to: 'target', profile: 'echo', [field]: 'arbitrary' }).success,
    ).toBe(false);
  }
});

async function audit(id: string) {
  return (await Bun.file(join(root, `${id}.jsonl`)).text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => AuditRecordSchema.parse(DiagnosticJournalFrameSchema.parse(JSON.parse(line)).event));
}

test('policy denial never tries an alternative broker with a wider grant', async () => {
  const extraTarget = startTarget(1);
  const policyCaller = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'policy',
      brokers: endpoints.map((endpoint) => ({ ...endpoint, token: policyToken })),
    }),
  );
  try {
    expect(
      await until(
        async () =>
          (await policyCaller.status()).lanes.every((lane) => lane.connected) &&
          (await extraTarget.status()).connected,
      ),
    ).toBe(true);
    expect(await policyCaller.call({ to: 'target', argv: ['echo'], stdin: null })).toMatchObject({
      failure: 'denied',
      refusal: 'policy',
    });
    // The next explicit request may use the other declared lane; it is not a retry.
    const frames = [];
    for await (const frame of policyCaller.openStream({
      to: 'target',
      profile: 'echo',
      args: [],
      stdin: null,
      cursor: null,
    }))
      frames.push(frame);
    expect(frames.at(-1)).toMatchObject({ reason: 'completed' });
    const denied = [];
    for await (const frame of policyCaller.openStream({
      to: 'target',
      profile: 'echo',
      args: [],
      stdin: null,
      cursor: null,
    }))
      denied.push(frame);
    expect(denied.at(-1)).toMatchObject({ failure: 'denied', refusal: 'policy' });
    expect(
      await until(async () =>
        (await audit('left')).some((row) => row.kind === 'call' && row.from === 'policy'),
      ),
    ).toBe(true);
    expect((await audit('right')).filter((row) => row.kind === 'call' && row.from === 'policy')).toHaveLength(
      0,
    );
    expect(
      (await audit('right')).filter((row) => row.kind === 'stream-open' && row.from === 'policy'),
    ).toHaveLength(1);
  } finally {
    await policyCaller.stop();
    await extraTarget.stop();
    expect(
      await until(async () =>
        (await caller.status()).nodes.some((node) => node.nodeId === 'target' && node.connections === 1),
      ),
    ).toBe(true);
  }
});

test('an executed timeout and an uncertain result after broker loss are never replayed', async () => {
  expect(
    await caller.call({ to: 'target', argv: ['sleep', '30'], stdin: null, timeoutMs: 1_000 }),
  ).toMatchObject({ failure: 'timeout' });
  const result = caller.call({ to: 'target', argv: ['sleep', '30'], stdin: null, timeoutMs: 3_000 });
  expect(
    await until(
      async () =>
        (await audit('left')).filter((row) => row.kind === 'call' && row.command === 'sleep').length === 2,
    ),
  ).toBe(true);
  const left = brokers[0];
  if (left === undefined) throw new Error('missing left broker');
  await left.stop();
  expect(await result).toMatchObject({
    failure: 'transport',
    transportCause: 'lane-lost-after-dispatch',
  });
  const before = serviceDispatches;
  expect(await service()).toMatchObject({ status: 'response', delivery: 'received' });
  expect(serviceDispatches - before).toBe(1);
  expect((await audit('right')).filter((row) => row.kind === 'call' && row.command === 'sleep')).toHaveLength(
    0,
  );
  await serviceTarget.stop();
  serviceTargetStopped = true;
  expect(
    await until(
      async () =>
        !(await caller.status()).nodes.some((node) => node.nodeId === 'service-target' && node.serves),
    ),
  ).toBe(true);
  expect(await service()).toMatchObject({
    status: 'failure',
    code: 'offline',
    delivery: 'not-dispatched',
    transportCause: 'target-offline',
  });
  expect(
    await until(async () =>
      (await audit('right')).some((row) => row.kind === 'service' && row.transportCause === 'target-offline'),
    ),
  ).toBe(true);
});
