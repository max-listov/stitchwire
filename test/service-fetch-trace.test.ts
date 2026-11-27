import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { createWireClient, WireClientError } from '../packages/client/src/index.ts';
import type { ServiceClientTrace } from '../packages/contracts/src/service/diagnostics.ts';
import type { ServiceDescriptor } from '../packages/contracts/src/service/policy-schema.ts';
import { WireServiceError } from '../packages/local-client/src/service.ts';
import { type DoorStand, startDoorStand } from './door-stand.ts';
import { until } from './support.ts';

/**
 * The trace a caller of `createServiceFetch` observes for a unary call, through the client, a door,
 * two agents and a broker: every `start` is closed by a `result`, whether the call was answered,
 * refused before it was sent, or ended by the caller.
 */

const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 20_000 };
const descriptor: ServiceDescriptor = {
  service: 'example.trace',
  revision: '1',
  maxInflight: 4,
  operations: [
    { id: 'answer', path: '/trace/answer', effect: 'read', limits, response: { kind: 'unary' } },
    { id: 'hold', path: '/trace/hold', effect: 'read', limits, response: { kind: 'unary' } },
  ],
};

const traces: ServiceClientTrace[] = [];
const reached: string[] = [];
const holding: { entered: boolean } = { entered: false };
let stand: DoorStand;

beforeAll(async () => {
  stand = await startDoorStand({
    descriptor,
    onTrace: (trace) => traces.push(trace),
    owner: async (request) => {
      const { pathname } = new URL(request.url);
      reached.push(pathname);
      if (pathname === '/trace/hold') {
        holding.entered = true;
        await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve()));
      }
      return new Response('{"answered":true}', { headers: { 'content-type': 'application/json' } });
    },
  });
});
afterAll(async () => {
  await stand?.stop();
});

const phases = () => traces.map((trace) => trace.phase);

test('an answered call is closed by a result that carries the target phases', async () => {
  traces.length = 0;
  const response = await stand.post('/trace/answer');
  expect(response.status).toBe(200);
  expect(phases()).toEqual(['start', 'result']);
  expect(traces[1]?.diagnostics?.phases.length).toBeGreaterThan(0);
  expect(new Set(traces.map((trace) => trace.traceId)).size).toBe(1);
});

test('a request body that is refused is closed by a result, and nothing reaches the owner', async () => {
  traces.length = 0;
  reached.length = 0;
  const failure = await stand
    .post('/trace/answer', undefined, 'not a JSON document')
    .catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(WireServiceError);
  expect(failure).toMatchObject({ outcome: { code: 'invalid-request', delivery: 'not-dispatched' } });
  expect(phases()).toEqual(['start', 'result']);
  expect(traces[1]?.diagnostics).toBeUndefined();
  expect(traces[0]?.traceId).toBe(traces[1]?.traceId);
  expect((failure as WireServiceError).traceId).toBe(traces[1]?.traceId);
  expect(reached).toEqual([]);
});

test('a call the caller ends while it is open is closed by a result that names who ended it', async () => {
  traces.length = 0;
  holding.entered = false;
  const withdrawal = new AbortController();
  const pending = stand.post('/trace/hold', withdrawal.signal).catch((e: unknown) => e);
  expect(await until(() => holding.entered)).toBe(true);
  expect(phases()).toEqual(['start']);
  withdrawal.abort();
  const failure = await pending;
  expect(failure).toBeInstanceOf(Error);
  expect(await until(() => phases().length === 2)).toBe(true);
  expect(phases()).toEqual(['start', 'result']);
  expect(traces[1]).toMatchObject({ traceId: traces[0]?.traceId, cancellationOrigin: 'caller-abort' });
});

test('invokeService closes its start with a result when the client call throws', async () => {
  const own: ServiceClientTrace[] = [];
  using client = createWireClient({
    socketPath: join(dirname(stand.ownerSocket), 'absent.sock'),
  });
  const failure = await client
    .invokeService(
      {
        to: 'absent',
        service: 'example.trace',
        revision: '1',
        operation: 'answer',
        payload: '{}',
        timeoutMs: 1_000,
      },
      { onTrace: (trace) => own.push(trace) },
    )
    .catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(WireClientError);
  expect(failure).toMatchObject({ code: 'unavailable', delivery: 'not-sent' });
  expect(own.map((trace) => trace.phase)).toEqual(['start', 'result']);
  expect(own[0]?.traceId).toBe(own[1]?.traceId);
});
