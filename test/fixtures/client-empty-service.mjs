import assert from 'node:assert/strict';
import { createServiceFetch } from '@stitchwire/client';
import { ApiError, createClient, defineContract } from 'stitchkit';
import { runtime } from './_door.mjs';
import { z } from 'zod';

const contract = defineContract(
  { prefix: '/empty-input' },
  {
    unary: {
      method: 'POST',
      path: '/unary',
      desc: 'Empty unary input',
      input: z.strictObject({}),
      output: z.strictObject({ accepted: z.literal(true) }),
    },
    stream: {
      method: 'POST',
      path: '/stream',
      desc: 'Empty stream input',
      input: z.strictObject({}),
      stream: {
        item: z.strictObject({ accepted: z.literal(true) }),
        lifetimeMs: 1000,
      },
    },
  },
);
const limits = { requestBytes: 1024, responseBytes: 1024, timeoutMs: 1000 };
const descriptor = {
  service: 'example.empty-input',
  revision: '1',
  maxInflight: 1,
  operations: [
    {
      id: 'unary',
      path: '/empty-input/unary',
      effect: 'read',
      limits,
      response: { kind: 'unary' },
    },
    {
      id: 'stream',
      path: '/empty-input/stream',
      effect: 'read',
      limits,
      response: { kind: 'stream', lifetimeMs: 30000 },
    },
  ],
};
const payloads = [];
let streamFrames = '{"type":"data","data":{"accepted":true}}\n{"type":"end"}\n';
const wire = {
  async invokeService(call) {
    payloads.push(call.payload);
    return {
      outcome: {
        status: 'response',
        delivery: 'received',
        httpStatus: 200,
        payload: '{"accepted":true}',
      },
    };
  },
  stream(call) {
    assert.equal(call.timeoutMs, 30000);
    payloads.push(call.source.payload);
    const items = [
      { kind: 'chunk', data: new TextEncoder().encode(streamFrames) },
      { kind: 'end', frame: { reason: 'completed' } },
    ];
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        const value = items.shift();
        return value === undefined ? { done: true, value: undefined } : { done: false, value };
      },
      async return() {
        items.length = 0;
        return { done: true, value: undefined };
      },
      close() {
        items.length = 0;
      },
    };
  },
};
const client = createClient(contract, {
  baseUrl: 'https://owner.invalid',
  fetch: createServiceFetch(wire, {
    to: 'worker',
    baseUrl: 'https://owner.invalid',
    descriptor,
  }),
});

assert.deepEqual(await client.unary({}), { accepted: true });
const streamed = [];
for await (const item of await client.stream({})) streamed.push(item);
assert.deepEqual(streamed, [{ accepted: true }]);
assert.deepEqual(payloads, ['{}', '{}']);
for (const retryable of [false, true, undefined]) {
  streamFrames = `${JSON.stringify({
    type: 'error',
    error: {
      code: 'SYNTHETIC_OWNER_ERROR',
      message: 'Synthetic owner stream refusal',
      ...(retryable === undefined ? {} : { retryable }),
    },
  })}\n`;
  const before = payloads.length;
  await assert.rejects(
    async () => {
      for await (const item of await client.stream({})) {
        assert.fail(`Error frame yielded a data item: ${JSON.stringify(item)}`);
      }
    },
    (error) => {
      assert(error instanceof ApiError);
      assert.equal(error.code, 'SYNTHETIC_OWNER_ERROR');
      assert.equal(error.retryable, retryable);
      return true;
    },
  );
  assert.equal(payloads.length, before + 1, 'owner stream error is not replayed');
  assert.equal(payloads.at(-1), '{}');
}
console.log(
  JSON.stringify({
    emptyInputUnary: true,
    emptyInputStream: true,
    ownerStreamRetryability: true,
    noReplay: true,
    payload: '{}',
    runtime,
  }),
);
