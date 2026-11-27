import { expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { createClient, defineContract } from 'stitchkit';
import { createHandler, implement } from 'stitchkit/server';
import { z } from 'zod';
import { createServiceFetch, createWireClient } from '../packages/client/src/index.ts';
import { bindUnixSocket } from 'stitchkit/files';
import { ServiceIngressSchema, type ServiceRoute } from '../packages/contracts/src/service/contracts.ts';
import { serviceDescriptorFromContract } from '../packages/contracts/src/service/contract-descriptor.ts';
import { ServicePolicySchema } from '../packages/contracts/src/service/policy-schema.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { isPrivateUnixEndpoint, ServiceExecutor } from '../packages/runtime/src/service/executor.ts';
import { ServiceLane } from '../packages/runtime/src/service/lane.ts';
import { ServiceTraceSchema } from '../packages/runtime/src/service/trace.ts';
import { brokerConfig, freePort, until, waitConnected } from './support.ts';

const ownerContract = defineContract(
  { prefix: '/catalog/1' },
  {
    query: {
      method: 'POST',
      effect: 'read',
      path: '/query',
      desc: 'query',
      input: z.object({ value: z.string().default('ok') }),
      output: z.object({ echoed: z.string() }),
      maxJsonBodyBytes: 1024,
      timeout: 2000,
    },
    empty: {
      method: 'POST',
      effect: 'read',
      path: '/empty',
      desc: 'empty input',
      input: z.strictObject({}),
      output: z.strictObject({ accepted: z.literal(true) }),
      maxJsonBodyBytes: 1024,
      timeout: 2000,
    },
    follow: {
      method: 'POST',
      effect: 'read',
      path: '/follow',
      desc: 'follow',
      input: z.object({ count: z.number().int().min(1).max(4), afterSeq: z.number().int().optional() }),
      timeout: 2000,
      stream: {
        item: z.object({ seq: z.number().int() }),
        lifetimeMs: 30000,
      },
    },
    watch: {
      method: 'POST',
      effect: 'read',
      path: '/watch',
      desc: 'empty stream input',
      input: z.strictObject({}),
      timeout: 5000,
      stream: {
        item: z.strictObject({ accepted: z.literal(true) }),
        lifetimeMs: 5000,
      },
    },
  },
);

const descriptor = serviceDescriptorFromContract(ownerContract, {
  service: 'example.catalog',
  revision: '1',
  maxInflight: 1,
  responseBytes: {
    query: 4096,
    empty: 4096,
    follow: 65536,
    watch: 65536,
  },
});
const grant = {
  caller: 'reader',
  target: 'worker',
  service: descriptor.service,
  scope: { kind: 'service-read' as const },
};

const endpointStat = (input: { uid: number; gid: number; mode: number; kind: 'socket' | 'directory' }) => ({
  uid: input.uid,
  gid: input.gid,
  mode: input.mode,
  isSocket: () => input.kind === 'socket',
  isDirectory: () => input.kind === 'directory',
});

test('owner endpoint accepts only the agent uid/gid without world access', () => {
  const identity = { uid: 100, gid: 200 };
  const socket = endpointStat({ ...identity, mode: 0o140660, kind: 'socket' });
  const directory = endpointStat({ ...identity, mode: 0o040750, kind: 'directory' });
  expect(isPrivateUnixEndpoint(socket, directory, identity)).toBe(true);
  expect(
    isPrivateUnixEndpoint(endpointStat({ ...identity, mode: 0o140666, kind: 'socket' }), directory, identity),
  ).toBe(false);
});

test('service lane loss settles once without replay and releases admission', async () => {
  const executor = new ServiceExecutor(ServicePolicySchema.parse({ bindings: [], grants: [] }), 'reader');
  let connected = true;
  let dispatches = 0;
  const lane = new ServiceLane('reader', executor, {
    call: () => {
      dispatches += 1;
      return connected;
    },
    cancel: () => {},
    result: () => {},
  });
  const call = {
    to: 'worker',
    service: 'example.catalog',
    revision: '1',
    operation: 'query',
    payload: '{}',
    timeoutMs: 1000,
  };

  const inFlight = lane.call(call);
  lane.disconnect();
  expect(await inFlight).toMatchObject({
    status: 'failure',
    code: 'unavailable',
    delivery: 'unknown',
    transportCause: 'lane-lost-after-dispatch',
  });
  expect(dispatches).toBe(1);

  connected = false;
  expect(await lane.call(call)).toMatchObject({
    status: 'failure',
    code: 'unavailable',
    delivery: 'not-dispatched',
    transportCause: 'no-connected-lane',
  });
  expect(dispatches).toBe(2);
});

test('one typed owner contract crosses Wire as unary and explicit-terminal stream', async () => {
  const root = await mkdtemp('/tmp/wire-service-runtime-');
  const socket = `${root}/owner.sock`;
  const descriptorPath = `${root}/descriptor.json`;
  let streamClosed = false;
  const ownerTraceIds: Array<string | null> = [];
  const abortEntered = Promise.withResolvers<void>();
  const abortObserved = Promise.withResolvers<void>();
  const abortedTrace = crypto.randomUUID();
  const ownerHandler = createHandler({
    services: [
      implement(ownerContract, {
        query: ({ input }) => ({ echoed: input.value }),
        empty: () => ({ accepted: true }),
        follow: ({ input }) => ({
          [Symbol.asyncIterator]: async function* () {
            try {
              for (let seq = (input.afterSeq ?? -1) + 1; seq < input.count; seq += 1) {
                yield { seq };
                if (input.count === 3 && seq === 0) await Bun.sleep(2300);
                if (input.count === 2) await Bun.sleep(250);
              }
            } finally {
              streamClosed = true;
            }
          },
        }),
        watch: () => ({
          [Symbol.asyncIterator]: async function* () {
            yield { accepted: true };
          },
        }),
      }),
    ],
  });
  const owner = bindUnixSocket({ path: socket, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      fetch: async (request) => {
        const call = ServiceIngressSchema.parse(await request.json());
        ownerTraceIds.push(request.headers.get('x-stitchwire-trace-id'));
        if (call.payload.includes('abort-probe')) {
          abortEntered.resolve();
          await new Promise<void>((resolve) => {
            if (request.signal.aborted) resolve();
            else request.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          abortObserved.resolve();
          return Response.json({});
        }
        if (call.operation === 'follow' && call.payload.includes('"count":4'))
          return new Response('', { headers: { 'content-type': 'application/x-ndjson' } });
        return ownerHandler(
          new Request(`http://owner.invalid/catalog/1/${call.operation}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: call.payload,
            signal: request.signal,
          }),
        );
      },
    }),
  );
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  const limits = { requestBytes: 1024, responseBytes: 65536, timeoutMs: 30000 };
  const policy = ServicePolicySchema.parse({
    bindings: [
      {
        service: descriptor.service,
        descriptorPath,
        socketPath: socket,
        endpointPath: '/v1/service',
        maxInflight: 1,
        limits,
      },
    ],
    grants: [grant],
  });
  const token = 'service-runtime-test-token'.padEnd(40, 'x');
  const port = freePort();
  const broker = await startBroker(
    brokerConfig({ reader: token, worker: token }, { port, serviceGrants: [grant] }),
  );
  const brokers = [{ id: 'primary', url: `http://127.0.0.1:${port}`, token }];
  const worker = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers,
      services: policy,
      agentSocket: `${root}/worker.sock`,
    }),
  );
  const reader = await startAgent(
    NodeConfigSchema.parse({ nodeId: 'reader', brokers, agentSocket: `${root}/reader.sock` }),
  );
  const wire = createWireClient({ socketPath: `${root}/reader.sock` });
  try {
    await waitConnected(reader, worker);
    const ownerClient = createClient(ownerContract, {
      baseUrl: 'https://owner.invalid',
      fetch: createServiceFetch(wire, {
        to: 'worker',
        descriptor,
        baseUrl: 'https://owner.invalid',
      }),
    });
    expect(await ownerClient.query({ value: 'hello' })).toEqual({ echoed: 'hello' });
    const sharedTrace = crypto.randomUUID();
    const diagnosticCall = {
      to: 'worker',
      service: descriptor.service,
      revision: '1',
      operation: 'query',
      payload: '{"value":"private-payload-sentinel"}',
      timeoutMs: 2000,
      traceId: sharedTrace,
    };
    const pair = await Promise.all([wire.invokeService(diagnosticCall), wire.invokeService(diagnosticCall)]);
    const successful = pair.find((result) => result.outcome.status === 'response');
    expect(successful?.traceId).toBe(sharedTrace);
    expect(successful?.outcome.diagnostics?.phases.map((entry) => entry.phase)).toEqual([
      'target-received',
      'descriptor-start',
      'descriptor-end',
      'admitted',
      'endpoint-start',
      'endpoint-end',
      'http-start',
      'http-headers',
      'body-start',
      'body-end',
      'terminal',
    ]);
    expect(pair[0]?.outcome.diagnostics?.requestId).not.toBe(pair[1]?.outcome.diagnostics?.requestId);
    expect(ownerTraceIds).toContain(sharedTrace);
    const abortController = new AbortController();
    const aborted = wire
      .invokeService(
        { ...diagnosticCall, traceId: abortedTrace, payload: '{"value":"abort-probe"}' },
        { signal: abortController.signal },
      )
      .catch((error: unknown) => error);
    await abortEntered.promise;
    abortController.abort();
    expect(await aborted).toMatchObject({
      code: 'cancelled',
      metadata: { traceId: abortedTrace, cancellationOrigin: 'caller-abort' },
    });
    await abortObserved.promise;
    // Owner disconnect precedes executor lease release; wait for the observable terminal record.
    expect(
      await until(async () =>
        (await readFile(`${root}/worker.sock.service-audit.jsonl`, 'utf8')).includes('door-disconnect'),
      ),
    ).toBe(true);
    expect(await ownerClient.empty({})).toEqual({ accepted: true });
    const values: number[] = [];
    for await (const item of await ownerClient.follow({ count: 3 })) values.push(item.seq);
    expect(values).toEqual([0, 1, 2]);
    using reconnectedWire = createWireClient({ socketPath: `${root}/reader.sock` });
    const reconnectedOwner = createClient(ownerContract, {
      baseUrl: 'https://owner.invalid',
      fetch: createServiceFetch(reconnectedWire, {
        to: 'worker',
        descriptor,
        baseUrl: 'https://owner.invalid',
      }),
    });
    const resumed: number[] = [];
    for await (const item of await reconnectedOwner.follow({ count: 3, afterSeq: 1 })) resumed.push(item.seq);
    expect(resumed).toEqual([2]);
    const emptyStream: Array<{ accepted: true }> = [];
    for await (const item of await ownerClient.watch({})) emptyStream.push(item);
    expect(emptyStream).toEqual([{ accepted: true }]);
    expect(streamClosed).toBe(true);
    streamClosed = false;
    for await (const _item of await ownerClient.follow({ count: 2 })) break;
    expect(await until(() => streamClosed)).toBe(true);
    await expect(
      (async () => {
        for await (const _item of await ownerClient.follow({ count: 4 })) {
          // Empty owner body must fail before any item can be delivered.
        }
      })(),
    ).rejects.toThrow();
  } finally {
    wire.close();
    await reader.stop();
    await worker.stop();
    await broker.stop();
    owner.stop(true);
    const audit = await readFile(`${root}/worker.sock.service-audit.jsonl`, 'utf8');
    expect(audit).not.toContain('private-payload-sentinel');
    const events = audit
      .trim()
      .split('\n')
      .map((line) => ServiceTraceSchema.extend({ ts: z.iso.datetime() }).parse(JSON.parse(line).event));
    expect(events.some((event) => event.phase === 'http-start')).toBe(true);
    expect(events.some((event) => event.phase === 'terminal')).toBe(true);
    expect(
      events.some(
        (event) =>
          event.traceId === abortedTrace &&
          event.phase === 'terminal' &&
          event.cancellationOrigin === 'door-disconnect',
      ),
    ).toBe(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

test('descriptor failures and insecure endpoints fail closed before owner execution', async () => {
  const root = await mkdtemp('/tmp/wire-service-bounds-');
  const socket = `${root}/owner.sock`;
  const descriptorPath = `${root}/descriptor.json`;
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 };
  const policy = ServicePolicySchema.parse({
    bindings: [
      {
        service: descriptor.service,
        descriptorPath,
        socketPath: socket,
        endpointPath: '/v1/service',
        maxInflight: 1,
        limits,
      },
    ],
    grants: [grant],
  });
  const executor = new ServiceExecutor(policy, 'worker');
  const call: ServiceRoute = {
    to: 'worker',
    service: descriptor.service,
    revision: '1',
    operation: 'query',
    payload: '{}',
    timeoutMs: 1000,
    id: crypto.randomUUID(),
    from: 'reader',
  };
  try {
    expect(await executor.execute(call, new AbortController().signal)).toMatchObject({
      code: 'unavailable',
      delivery: 'not-dispatched',
    });
    // The owner answers only when the test lets it, so the deadline below is what ends the call.
    const answer = Promise.withResolvers<void>();
    const owner = Bun.serve({
      unix: socket,
      fetch: () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              await answer.promise;
              controller.enqueue(new TextEncoder().encode('{"ok":true}'));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    });
    try {
      await chmod(socket, 0o666);
      expect(await executor.execute(call, new AbortController().signal)).toMatchObject({ code: 'denied' });
      await chmod(socket, 0o600);
      // Long enough that the request is on the wire before the deadline, however loaded the machine is.
      expect(await executor.execute({ ...call, timeoutMs: 300 }, new AbortController().signal)).toMatchObject(
        {
          code: 'timeout',
          delivery: 'unknown',
        },
      );
      await writeFile(descriptorPath, '{');
      expect(await executor.execute(call, new AbortController().signal)).toMatchObject({
        code: 'invalid-response',
      });
    } finally {
      answer.resolve();
      owner.stop(true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
