import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createWireClient, WireClientError } from '../packages/client/src/index.ts';
import { bindUnixSocket } from 'stitchkit/files';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';
import {
  type ServiceCall,
  ServiceCallSchema,
  ServiceOutcomeSchema,
  type ServiceResult,
  type ServiceRoute,
} from '../packages/contracts/src/service/contracts.ts';
import type { ServiceCancellationOrigin } from '../packages/contracts/src/service/diagnostics.ts';
import { ServicePolicySchema } from '../packages/contracts/src/service/policy-schema.ts';
import { ServiceRouter } from '../packages/runtime/src/service/broker.ts';
import { ServiceDispatchBudget } from '../packages/runtime/src/service/dispatch-budget.ts';
import { ServiceExecutor } from '../packages/runtime/src/service/executor.ts';
import { ServiceLane } from '../packages/runtime/src/service/lane.ts';
import { until } from './support.ts';

const call: ServiceCall = {
  to: 'worker',
  service: 'example.read',
  revision: '1',
  operation: 'read',
  payload: '{}',
  timeoutMs: 10,
};
const response = ServiceOutcomeSchema.parse({
  status: 'response',
  delivery: 'received',
  httpStatus: 200,
  payload: '{}',
});

test('first cancellation wins and cleanup never turns success into a timeout', async () => {
  const caller = new AbortController();
  const budget = new ServiceDispatchBudget(caller.signal, 10);
  caller.abort('door-disconnect');
  // Absence: the 10ms deadline must not fire once the caller has gone, so the clock is the instrument.
  await Bun.sleep(20);
  expect(budget.timedOut).toBe(false);
  expect(budget.controller.signal.reason).toBe('door-disconnect');
  budget.close();
  expect(budget.controller.signal.reason).toBe('door-disconnect');
  const late = new AbortController();
  const timed = new ServiceDispatchBudget(late.signal, 1);
  expect(await until(() => timed.timedOut)).toBe(true);
  late.abort('caller-abort');
  expect(timed.timedOut).toBe(true);
  expect(timed.controller.signal.reason).toBe('executor-deadline');
  timed.close();
  const completed = new ServiceDispatchBudget(new AbortController().signal, 1);
  completed.close();
  // Absence: a closed budget's 1ms deadline must never fire.
  await Bun.sleep(5);
  expect(completed.timedOut).toBe(false);
});

test('lane provenance survives deadline and abort, IDs do not reuse caller trace ID, leases recover', async () => {
  const origins: ServiceCancellationOrigin[] = [];
  const routes: ServiceRoute[] = [];
  const lane = new ServiceLane(
    'reader',
    new ServiceExecutor(ServicePolicySchema.parse({ bindings: [], grants: [] }), 'reader'),
    {
      call: (route) => {
        routes.push(route);
        return true;
      },
      cancel: (_id, _to, origin) => {
        origins.push(origin);
      },
      result: () => {},
    },
  );
  const traceId = crypto.randomUUID();
  const a = new AbortController();
  const first = lane.call({ ...call, traceId, timeoutMs: 100 }, a.signal);
  const second = lane.call({ ...call, traceId });
  a.abort('door-disconnect');
  expect(await first).toMatchObject({
    code: 'cancelled',
    delivery: 'unknown',
    cancellationOrigin: 'door-disconnect',
  });
  expect(await second).toMatchObject({
    code: 'timeout',
    delivery: 'unknown',
    cancellationOrigin: 'caller-deadline',
  });
  expect(routes[0]?.id).not.toBe(routes[1]?.id);
  expect(routes[0]?.id).not.toBe(traceId);
  expect(origins).toEqual(['door-disconnect', 'caller-deadline']);
  for (let i = 0; i < 64; i++) {
    const controller = new AbortController();
    const pending = lane.call(call, controller.signal);
    controller.abort('caller-abort');
    expect(await pending).toMatchObject({ cancellationOrigin: 'caller-abort' });
  }
  for (let i = 0; i < 40; i++) {
    const pending = lane.call(call);
    const route = routes.at(-1);
    if (!route) throw new Error('missing route');
    lane.result({ id: route.id, from: 'worker', outcome: response });
    expect(await pending).toEqual(response);
  }
  // Absence: a settled call must not be cancelled afterwards.
  await Bun.sleep(20);
  expect(origins).toHaveLength(66);
});

test('router separates trusted terminal sources and rejects foreign cancellation and forged broker origin', async () => {
  const results: ServiceResult[] = [];
  const router = new ServiceRouter(
    () => [{ caller: 'reader', target: 'worker', service: call.service, scope: { kind: 'service-read' } }],
    {
      target: () => 'target-socket',
      invoke: () => {},
      result: (_socket, result) => results.push(result),
      cancel: () => {},
      audit: () => {},
    },
  );
  const route = (): ServiceRoute => ({ ...call, from: 'reader', id: crypto.randomUUID(), timeoutMs: 100 });
  const a = route();
  router.call('caller-socket', 'reader', a);
  router.cancel('foreign-socket', a.id, 'caller-abort');
  router.cancel('caller-socket', a.id, 'broker-deadline');
  expect(results).toHaveLength(0);
  router.cancel('caller-socket', a.id, 'caller-deadline');
  expect(results.at(-1)?.outcome).toMatchObject({
    cancellationOrigin: 'caller-deadline',
    delivery: 'unknown',
  });
  router.result('target-socket', { id: a.id, from: 'worker', outcome: response });
  expect(results).toHaveLength(1);
  router.call('caller-socket', 'reader', route());
  router.disconnect('caller-socket');
  expect(results.at(-1)?.outcome).toMatchObject({ cancellationOrigin: 'caller-disconnect' });
  router.call('caller-socket', 'reader', route());
  router.disconnect('target-socket');
  expect(results.at(-1)?.outcome).toMatchObject({
    cancellationOrigin: 'target-disconnect',
    delivery: 'unknown',
  });
  const answered = results.length;
  router.call('caller-socket', 'reader', { ...route(), timeoutMs: 20 });
  expect(await until(() => results.length > answered)).toBe(true);
  expect(results.at(-1)?.outcome).toMatchObject({ cancellationOrigin: 'broker-deadline' });
  for (let i = 0; i < 64; i++) {
    const current = route();
    router.call('caller-socket', 'reader', current);
    router.cancel('caller-socket', current.id, 'caller-abort');
    expect(results.at(-1)?.outcome).toMatchObject({ cancellationOrigin: 'caller-abort' });
  }
  for (let i = 0; i < 40; i++) {
    const current = route();
    router.call('caller-socket', 'reader', current);
    router.result('target-socket', { id: current.id, from: 'worker', outcome: response });
    expect(results.at(-1)?.outcome).toEqual(response);
  }
  router.call('caller-socket', 'reader', route());
  router.stop();
  expect(results.at(-1)?.outcome).toMatchObject({ cancellationOrigin: 'broker-shutdown' });
});

test('SDK exposes correlation before early invalid and closed failures', async () => {
  const client = createWireClient({ socketPath: '/nonexistent/wire-diagnostics.sock' });
  client.close();
  for (const input of [call, { ...call, timeoutMs: 0 }]) {
    let observed: string | undefined;
    try {
      await client.invokeService(input, {
        onTrace: ({ traceId }) => {
          observed = traceId;
        },
      });
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(WireClientError);
      if (!(error instanceof WireClientError)) throw error;
      expect(error.metadata.traceId).toBe(observed);
      expect(observed).toBeDefined();
      expect(error.delivery).toBe('not-sent');
    }
  }
});

test('real Unix SDK keeps concurrent trace IDs when deadline and external abort beat the response', async () => {
  const root = await mkdtemp('/tmp/wire-sdk-trace-');
  const socket = `${root}/door.sock`;
  const received: string[] = [];
  const entered = Promise.withResolvers<void>();
  const server = bindUnixSocket({ path: socket, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      async fetch(request) {
        const input = ServiceCallSchema.parse(await request.json());
        if (input.traceId) received.push(input.traceId);
        if (received.length === 2) entered.resolve();
        await Bun.sleep(150);
        return Response.json({ v: LOCAL_API_VERSION, traceId: input.traceId, outcome: response });
      },
    }),
  );
  using client = createWireClient({ socketPath: socket });
  const ids: string[] = [];
  const controller = new AbortController();
  const invoke = async (timeoutMs: number, signal?: AbortSignal) => {
    try {
      await client.invokeService(
        { ...call, timeoutMs },
        {
          signal,
          onTrace: (event) => {
            if (event.phase === 'start') ids.push(event.traceId);
          },
        },
      );
      throw new Error('expected timeout');
    } catch (error) {
      if (!(error instanceof WireClientError)) throw error;
      return error;
    }
  };
  try {
    const deadline = invoke(80);
    const aborted = invoke(500, controller.signal);
    await entered.promise;
    controller.abort();
    const [a, b] = await Promise.all([deadline, aborted]);
    expect(a.metadata).toMatchObject({ traceId: ids[0], cancellationOrigin: 'caller-deadline' });
    expect(b.metadata).toMatchObject({ traceId: ids[1], cancellationOrigin: 'caller-abort' });
    expect(a.delivery).toBe('unknown');
    expect(b.delivery).toBe('unknown');
    expect(ids[0]).not.toBe(ids[1]);
    expect(received.sort()).toEqual(ids.sort());
    using shortHeaders = createWireClient({ socketPath: socket, openTimeoutMs: 10 });
    expect((await shortHeaders.invokeService({ ...call, timeoutMs: 1000 })).outcome).toEqual(response);
    const error = await shortHeaders
      .invokeService({ ...call, timeoutMs: 20 })
      .catch((error: unknown) => error);
    if (!(error instanceof WireClientError)) throw new Error('expected operation timeout');
    expect(error).toMatchObject({
      code: 'timeout',
      delivery: 'unknown',
      metadata: { cancellationOrigin: 'caller-deadline' },
    });
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
