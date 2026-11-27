import assert from 'node:assert/strict';
import { createServiceIngress, serviceCaller } from '@stitchwire/client';
import { createHandler, implement } from 'stitchkit/server';
import { defineContract } from 'stitchkit';
import { z } from 'zod';

const contract = defineContract(
  { prefix: '/catalog', scope: 'catalog' },
  {
    lookup: {
      method: 'POST',
      path: '/lookup',
      desc: 'Read a synthetic item',
      input: z.strictObject({ key: z.string() }),
      output: z.strictObject({ key: z.string(), caller: z.string().nullable() }),
      maxJsonBodyBytes: 1024,
    },
  },
);
const descriptor = {
  service: 'example.catalog',
  revision: '1',
  maxInflight: 1,
  operations: [
    {
      id: 'lookup',
      path: '/catalog/lookup',
      effect: 'read',
      limits: { requestBytes: 1024, responseBytes: 1024, timeoutMs: 1000 },
      response: { kind: 'unary' },
    },
  ],
};
let reached = 0;
const handler = createHandler({
  services: [
    implement(contract, {
      lookup: (context) => {
        reached += 1;
        return { key: context.input.key, caller: serviceCaller(context)?.caller ?? null };
      },
    }),
  ],
});
const ingress = createServiceIngress({ descriptor, handler, bodyTimeoutMs: 20 });
const envelope = (overrides = {}) =>
  new Request('http://owner.invalid/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      v: 1,
      id: crypto.randomUUID(),
      caller: 'reader',
      service: 'example.catalog',
      revision: '1',
      operation: 'lookup',
      payload: '{"key":"example"}',
      ...overrides,
    }),
  });

const answered = await ingress(envelope());
assert.equal(answered.status, 200);
assert.deepEqual(await answered.json(), { key: 'example', caller: 'reader' });
assert.equal(reached, 1);

// The same Stitchkit handler reached by any other door sees no caller, even with the header the node does not set.
const direct = await handler(
  new Request('http://owner.invalid/catalog/lookup', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-stitchwire-caller': 'operator' },
    body: '{"key":"example"}',
  }),
);
assert.deepEqual(await direct.json(), { key: 'example', caller: null });

for (const overrides of [{ service: 'other.catalog' }, { revision: '2' }, { operation: 'erase' }, { v: 2 }]) {
  const refused = await ingress(envelope(overrides));
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, 'invalid-request');
}
assert.equal(reached, 2, 'a refused envelope reached the owner handler');

// A body that never arrives is cancelled at the read deadline, refused, and never reaches the handler.
let cancelled;
const cancelledOnce = new Promise((resolve) => {
  cancelled = resolve;
});
const stuck = await ingress(
  new Request('http://owner.invalid/invoke', {
    method: 'POST',
    body: new ReadableStream({ pull: () => new Promise(() => {}), cancel: cancelled }),
    duplex: 'half',
  }),
);
assert.equal(stuck.status, 400);
assert.deepEqual(await stuck.json(), {
  error: 'invalid-request',
  detail: 'service envelope was not read within its deadline',
});
await cancelledOnce;
assert.equal(reached, 2, 'a stalled envelope reached the owner handler');
assert.throws(() => createServiceIngress({ descriptor, handler, bodyTimeoutMs: 0 }));
console.log(
  `${typeof Bun === 'undefined' ? 'node' : 'bun'}: service ingress delivers the caller and refuses foreign envelopes and a stalled body`,
);
