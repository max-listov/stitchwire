import assert from 'node:assert/strict';
import {
  LOCAL_API_VERSION,
  createServiceFetch,
  createWireClient,
  WireServiceError,
} from '@stitchwire/client';
import { ApiError, createClient, defineContract } from 'stitchkit';
import { openDoor, readJson, runtime } from './_door.mjs';
import { z } from 'zod';

// Synthetic owner contract: domain correlation stays inside the opaque payload.
const Input = z.object({ id: z.string(), mode: z.string() });
const Output = z.object({ id: z.string(), value: z.string() });
const contract = defineContract(
  { prefix: '/example' },
  {
    read: { method: 'POST', path: '/read', desc: 'Read synthetic item', input: Input, output: Output },
    demand: { method: 'POST', path: '/demand', desc: 'Demand synthetic work', input: Input, output: Output },
  },
);
const limits = { requestBytes: 1024, responseBytes: 1024, timeoutMs: 1000 };
const composition = {
  baseUrl: 'http://example.invalid',
  descriptor: {
    service: 'example.owner',
    revision: '1',
    maxInflight: 8,
    operations: [
      { id: 'read', path: '/example/read', effect: 'read', limits, response: { kind: 'unary' } },
      { id: 'demand', path: '/example/demand', effect: 'write', limits, response: { kind: 'unary' } },
    ],
  },
};
let dispatches = 0;
const ownerIds = [];
const transportIds = [];
const door = await openDoor('composition', async (req, res) => {
  const call = await readJson(req);
  const input = Input.parse(JSON.parse(call.payload));
  dispatches++;
  ownerIds.push(input.id);
  transportIds.push(crypto.randomUUID());
  if (input.mode === 'hang') return;
  if (input.mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 20));
  let outcome;
  if (['denied', 'capacity', 'offline', 'timeout'].includes(input.mode)) {
    outcome = {
      status: 'failure',
      code: input.mode,
      delivery: input.mode === 'timeout' ? 'unknown' : 'not-dispatched',
      retryAfterMs: input.mode === 'capacity' ? 250 : null,
      refusal: input.mode === 'denied' ? 'policy' : input.mode === 'capacity' ? 'capacity' : 'none',
      transportCause:
        input.mode === 'offline'
          ? 'target-offline'
          : input.mode === 'timeout'
            ? 'acknowledgement-timeout'
            : null,
    };
  } else if (input.mode.startsWith('owner-error-')) {
    const retryable =
      input.mode === 'owner-error-true' ? true : input.mode === 'owner-error-false' ? false : undefined;
    outcome = {
      status: 'response',
      delivery: 'received',
      httpStatus: retryable === true ? 409 : 502,
      payload: JSON.stringify({
        error: {
          code: 'SYNTHETIC_OWNER_ERROR',
          message: 'Synthetic owner refusal',
          ...(retryable === undefined ? {} : { retryable }),
        },
      }),
    };
  } else {
    outcome = {
      status: 'response',
      delivery: 'received',
      httpStatus: input.mode === 'http' ? 409 : 200,
      payload: JSON.stringify(
        input.mode === 'invalid' ? { bad: true } : { id: input.id, value: 'synthetic' },
      ),
    };
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ v: LOCAL_API_VERSION, outcome: { ...outcome, future: true }, future: true }));
});
const wire = createWireClient({ socketPath: door.socketPath });
const ownerFetch = createServiceFetch(wire, { to: 'worker', ...composition });
const typed = createClient(contract, { baseUrl: composition.baseUrl, fetch: ownerFetch });

// An invocation-shaped owner supplies this adapter; it throws the original transport cause.
const invoke = async (operation, input, signal) => {
  const { outcome } = await wire.invokeService(
    {
      to: 'worker',
      service: composition.descriptor.service,
      revision: composition.descriptor.revision,
      operation,
      payload: JSON.stringify(input),
      timeoutMs: limits.timeoutMs,
    },
    { signal },
  );
  if (outcome.status === 'failure') throw new WireServiceError(outcome);
  if (outcome.httpStatus !== 200) throw new Error('Owner HTTP failure', { cause: outcome });
  const output = Output.parse(JSON.parse(outcome.payload));
  if (output.id !== input.id) throw new Error('Owner correlation mismatch');
  return output;
};
function findCause(error, type) {
  for (let value = error, depth = 0; value && depth < 8; value = value.cause, depth++) {
    if (value instanceof type) return value;
  }
  return undefined;
}
try {
  const results = await Promise.all([
    typed.read({ id: 'fetch-slow', mode: 'slow' }),
    typed.read({ id: 'fetch-fast', mode: 'ok' }),
    invoke('read', { id: 'invoke-slow', mode: 'slow' }),
    invoke('demand', { id: 'invoke-fast', mode: 'ok' }),
  ]);
  assert.deepEqual(
    results.map((value) => value.id),
    ['fetch-slow', 'fetch-fast', 'invoke-slow', 'invoke-fast'],
  );
  assert.equal(new Set(transportIds).size, 4);
  assert.ok(transportIds.every((id) => !ownerIds.includes(id)));
  for (const mode of ['denied', 'capacity', 'offline', 'timeout']) {
    for (const call of [() => typed.demand({ id: mode, mode }), () => invoke('demand', { id: mode, mode })]) {
      const before = dispatches;
      await assert.rejects(call, (error) => {
        const cause = findCause(error, WireServiceError);
        assert.equal(cause?.outcome.code, mode);
        assert.equal(cause.delivery, mode === 'timeout' ? 'unknown' : 'not-dispatched');
        assert.equal(cause.outcome.retryAfterMs, mode === 'capacity' ? 250 : null);
        return true;
      });
      assert.equal(dispatches, before + 1, 'unknown demand is never retried');
    }
  }
  for (const retryable of [false, true, undefined]) {
    const mode = `owner-error-${String(retryable)}`;
    const before = dispatches;
    await assert.rejects(
      () => typed.demand({ id: mode, mode }),
      (error) => {
        assert(error instanceof ApiError);
        assert.equal(error.code, 'SYNTHETIC_OWNER_ERROR');
        assert.equal(error.status, retryable === true ? 409 : 502);
        assert.equal(error.retryable, retryable);
        return true;
      },
    );
    assert.equal(dispatches, before + 1, 'owner retryable recommendation does not enable replay');
  }
  await assert.rejects(() => typed.read({ id: 'bad', mode: 'invalid' }));
  await assert.rejects(() => invoke('read', { id: 'bad', mode: 'invalid' }));
  assert.equal(
    (
      await ownerFetch('http://example.invalid/example/read', {
        method: 'POST',
        body: JSON.stringify({ id: 'http', mode: 'http' }),
      })
    ).status,
    409,
  );
  const before = dispatches;
  for (const url of ['http://other.invalid/example/read', 'http://example.invalid/arbitrary']) {
    await assert.rejects(() => ownerFetch(url, { method: 'POST', body: '{}' }), {
      delivery: 'not-dispatched',
    });
  }
  await assert.rejects(() => typed.read({ id: 'x'.repeat(2048), mode: 'ok' }));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(() =>
    typed.read.withOptions({ id: 'cancel', mode: 'ok' }, { signal: cancelled.signal }),
  );
  assert.equal(dispatches, before, 'local refusal cannot dispatch');
  await assert.rejects(() => invoke('read', { id: 'deadline', mode: 'hang' }), {
    code: 'timeout',
    delivery: 'unknown',
  });
  await assert.rejects(() => invoke('read', { id: 'cancel-body', mode: 'hang' }, AbortSignal.timeout(25)), {
    code: 'cancelled',
    delivery: 'unknown',
  });
  console.log(
    JSON.stringify({
      composition: true,
      concurrentCorrelation: true,
      causePreserved: true,
      noReplay: true,
      ownerRetryability: true,
      runtime,
    }),
  );
} finally {
  wire.close();
  await door.close();
}
