import assert from 'node:assert/strict';
import { createServiceFetch } from '@stitchwire/client';
import { runtime } from './_door.mjs';

const limit = 1048576;
let dispatches = 0;
const payloads = [];
const adapter = createServiceFetch(
  {
    async invokeService(call) {
      dispatches++;
      payloads.push(call.payload);
      return { outcome: { status: 'response', delivery: 'received', httpStatus: 200, payload: '{}' } };
    },
    stream() {
      throw new Error('unexpected stream');
    },
  },
  {
    to: 'worker',
    baseUrl: 'http://owner.invalid',
    descriptor: {
      service: 'example.documents',
      revision: '1',
      maxInflight: 1,
      operations: [
        {
          id: 'write',
          path: '/write',
          effect: 'read',
          limits: { requestBytes: limit, responseBytes: 1024, timeoutMs: 1000 },
          response: { kind: 'unary' },
        },
      ],
    },
  },
);
const invoke = (body, headers, signal) =>
  adapter('http://owner.invalid/write', {
    method: 'POST',
    body,
    headers,
    signal,
  });
for (const bytes of [93 * 1024, limit]) {
  const body = `${' '.repeat(bytes - 2)}{}`;
  await invoke(body);
  assert.equal(payloads.at(-1), body);
}
const before = dispatches;
const oversized = `${' '.repeat(limit - 1)}{}`;
for (const headers of [undefined, { 'content-length': '1' }]) {
  await assert.rejects(
    invoke(oversized, headers),
    (e) => e.outcome.code === 'invalid-request' && e.delivery === 'not-dispatched',
  );
}
await assert.rejects(
  invoke('{}', { 'content-length': String(limit + 1) }),
  (e) => e.outcome.code === 'invalid-request',
);
const controller = new AbortController();
let cancelled = false;
const reading = Promise.withResolvers();
const body = new ReadableStream(
  {
    pull() {
      reading.resolve();
    },
    cancel() {
      cancelled = true;
    },
  },
  { highWaterMark: 0 },
);
const pending = adapter(
  new Request('http://owner.invalid/write', {
    method: 'POST',
    body,
    duplex: 'half',
    signal: controller.signal,
  }),
);
await reading.promise;
controller.abort();
await assert.rejects(pending, (e) => e.outcome.code === 'cancelled' && e.delivery === 'not-dispatched');
assert.equal(cancelled, true);
assert.equal(dispatches, before);
console.log(
  JSON.stringify({
    largeRequestBytes: limit,
    boundedReads: true,
    abortReleased: true,
    runtime,
  }),
);
