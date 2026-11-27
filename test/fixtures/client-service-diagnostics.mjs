import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWireClient, createServiceFetch, WireClientError, LOCAL_API_VERSION } from '@stitchwire/client';
import { createClient, defineContract, ApiError } from 'stitchkit';
import { z } from 'zod';
import { openDoor, readJson, runtime } from './_door.mjs';

const received = [];
const door = await openDoor('service-diagnostics', async (req, res) => {
  const call = await readJson(req);
  received.push(call.traceId);
  if (call.payload === '{"hang":true}') return;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      v: LOCAL_API_VERSION,
      traceId: call.traceId,
      outcome: {
        status: 'response',
        delivery: 'received',
        httpStatus: 200,
        payload: '{"ok":true}',
        diagnostics: {
          traceId: call.traceId,
          requestId: randomUUID(),
          phases: [{ phase: 'terminal', elapsedMs: 1 }],
        },
      },
    }),
  );
});
const client = createWireClient({ socketPath: door.socketPath });
const input = {
  to: 'worker',
  service: 'example.read',
  revision: '1',
  operation: 'read',
  payload: '{}',
  // Answered calls get a deadline a loaded host meets; only the hanging calls below are given one
  // they are meant to miss.
  timeoutMs: 10_000,
};
const MISSED_DEADLINE_MS = 100;
try {
  const starts = [];
  const pair = await Promise.all([
    client.invokeService(input, { onTrace: (trace) => starts.push(trace) }),
    client.invokeService(input),
  ]);
  assert.notEqual(pair[0].traceId, pair[1].traceId);
  assert.equal(starts[0].phase, 'start');
  assert.equal(starts[1].diagnostics.traceId, pair[0].traceId);
  let timedTrace;
  await assert.rejects(
    client.invokeService(
      { ...input, payload: '{"hang":true}', timeoutMs: MISSED_DEADLINE_MS },
      {
        onTrace: (trace) => {
          timedTrace = trace.traceId;
        },
      },
    ),
    (error) => {
      assert(error instanceof WireClientError);
      assert.equal(error.metadata.traceId, timedTrace);
      assert.equal(error.metadata.cancellationOrigin, 'caller-deadline');
      assert.equal(error.delivery, 'unknown');
      return true;
    },
  );
  const events = [];
  const serviceFetch = (timeoutMs) =>
    createServiceFetch(client, {
      to: 'worker',
      baseUrl: 'http://example.invalid',
      onTrace: (trace) => events.push(trace),
      descriptor: {
        service: 'example.read',
        revision: '1',
        maxInflight: 2,
        operations: [
          {
            id: 'read',
            path: '/read',
            effect: 'read',
            limits: { requestBytes: 1024, responseBytes: 1024, timeoutMs },
            response: { kind: 'unary' },
          },
        ],
      },
    });
  const fetch = serviceFetch(input.timeoutMs);
  const response = await fetch('http://example.invalid/read', { method: 'POST', body: '{}' });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('x-stitchwire-trace-id'), events[0].traceId);
  assert.equal(events[1].diagnostics.traceId, events[0].traceId);
  assert.equal(JSON.stringify(events).includes('payload'), false);
  assert.equal(received.length, 4);
  const contract = defineContract(
    { prefix: '' },
    {
      read: {
        method: 'POST',
        path: '/read',
        desc: 'Read',
        input: z.object({ hang: z.boolean() }),
        output: z.object({ ok: z.boolean() }),
      },
    },
  );
  const typed = createClient(contract, {
    baseUrl: 'http://example.invalid',
    fetch: serviceFetch(MISSED_DEADLINE_MS),
  });
  await assert.rejects(typed.read({ hang: true }), (error) => {
    assert(error instanceof ApiError);
    let cause = error;
    for (let i = 0; i < 8 && !(cause instanceof WireClientError); i++) cause = cause?.cause;
    assert(cause instanceof WireClientError);
    assert.equal(cause.metadata.cancellationOrigin, 'caller-deadline');
    assert.equal(cause.metadata.traceId, events.at(-1).traceId);
    return true;
  });
  console.log(
    JSON.stringify({
      serviceDiagnostics: true,
      concurrentCorrelation: true,
      deadlineTrace: true,
      adapterObservation: true,
      runtime,
    }),
  );
} finally {
  client.close();
  await door.close();
}
