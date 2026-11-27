import { expect, spyOn, test } from 'bun:test';
import { ZodError } from 'zod';
import { createServiceIngress, serviceCaller } from '../packages/client/src/index.ts';
import type { ServiceDescriptor } from '../packages/contracts/src/service/policy-schema.ts';
import { jsonEnvelopeBytes } from '../packages/contracts/src/protocol/json-bounds.ts';

const descriptor: ServiceDescriptor = {
  service: 'example.catalog',
  revision: '1',
  maxInflight: 2,
  operations: [
    {
      id: 'lookup',
      path: '/catalog/lookup',
      effect: 'read',
      limits: { requestBytes: 64, responseBytes: 1024, timeoutMs: 1000 },
      response: { kind: 'unary' },
    },
    {
      id: 'tail',
      path: '/catalog/tail',
      effect: 'read',
      limits: { requestBytes: 256, responseBytes: 1024, timeoutMs: 1000 },
      response: { kind: 'stream' },
    },
  ],
};

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: crypto.randomUUID(),
    caller: 'reader',
    service: 'example.catalog',
    revision: '1',
    operation: 'lookup',
    payload: '{"key":"example"}',
    ...overrides,
  };
}

function post(body: string, headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request('http://owner.invalid/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    signal,
  });
}

/** The one request the handler received; fails the test where the handler was never reached. */
function reached(received: Request[]): Request {
  const [request] = received;
  if (request === undefined) throw new Error('the handler was not reached');
  return request;
}

function owner() {
  const received: Request[] = [];
  const answer = new Response('{"ok":true}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const ingress = createServiceIngress({
    descriptor,
    handler: (request) => {
      received.push(request);
      return answer;
    },
  });
  return { ingress, received, answer };
}

test('a valid envelope reaches the handler as the declared POST with the payload and a caller only the helper can set', async () => {
  const { ingress, received, answer } = owner();
  const call = envelope();
  const traceId = crypto.randomUUID();
  const response = await ingress(post(JSON.stringify(call), { 'x-stitchwire-trace-id': traceId }));
  expect(response).toBe(answer);
  expect(received).toHaveLength(1);
  const request = reached(received);
  expect(request.method).toBe('POST');
  expect(new URL(request.url).pathname).toBe('/catalog/lookup');
  expect(request.headers.get('content-type')).toBe('application/json');
  expect(await request.text()).toBe('{"key":"example"}');
  expect(serviceCaller({ req: request })).toEqual({
    caller: 'reader',
    operation: 'lookup',
    id: call.id as string,
    traceId,
  });
});

test('a missing or malformed trace header falls back to the call id', async () => {
  const absent: Record<string, string> = {};
  for (const headers of [absent, { 'x-stitchwire-trace-id': 'not-a-uuid' }]) {
    const { ingress, received } = owner();
    const call = envelope();
    await ingress(post(JSON.stringify(call), headers));
    expect(serviceCaller({ req: reached(received) })?.traceId).toBe(call.id as string);
  }
});

test('stream operations are forwarded to the handler like unary ones', async () => {
  const { ingress, received } = owner();
  await ingress(post(JSON.stringify(envelope({ operation: 'tail', payload: '{}' }))));
  expect(new URL(reached(received).url).pathname).toBe('/catalog/tail');
  expect(serviceCaller({ req: reached(received) })?.operation).toBe('tail');
});

test('what the descriptor does not declare is refused as invalid-request and never reaches the handler', async () => {
  const oversizedPayload = JSON.stringify({ key: 'x'.repeat(80) });
  const refused: Array<[string, string, Record<string, string>?]> = [
    ['foreign service', JSON.stringify(envelope({ service: 'other.catalog' }))],
    ['foreign revision', JSON.stringify(envelope({ revision: '2' }))],
    ['unknown operation', JSON.stringify(envelope({ operation: 'erase' }))],
    ['version 2', JSON.stringify(envelope({ v: 2 }))],
    ['extra field', JSON.stringify(envelope({ extra: true }))],
    ['payload that is not JSON', JSON.stringify(envelope({ payload: 'not json' }))],
    ['payload over the operation limit', JSON.stringify(envelope({ payload: oversizedPayload }))],
    ['not JSON', '{"v":'],
    ['not an object', '[]'],
    ['empty body', ''],
  ];
  for (const [label, body] of refused) {
    const { ingress, received } = owner();
    const response = await ingress(post(body));
    expect(response.status, label).toBe(400);
    expect(await response.json(), label).toMatchObject({ error: 'invalid-request' });
    expect(received, label).toHaveLength(0);
  }
});

/** A body that counts what is read from it, so a refusal can be shown to happen before the read, not after. */
function counting(chunkBytes: number, chunks: number) {
  const read = { chunks: 0 };
  // highWaterMark 0: nothing is pulled until a reader asks, so the count is the reader's, not the queue's.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (read.chunks >= chunks) return controller.close();
        read.chunks += 1;
        controller.enqueue(new Uint8Array(chunkBytes).fill(32));
      },
    },
    { highWaterMark: 0 },
  );
  return { read, body };
}

function streamed(body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}): Request {
  return new Request('http://owner.invalid/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
    // The standard asks for it on a streamed body; the Bun and undici typings differ on the field.
    ...({ duplex: 'half' } as object),
  });
}

test('a body past the widest declared envelope is refused while it is read and the read stops there', async () => {
  const { ingress, received } = owner();
  const ceiling = jsonEnvelopeBytes(256);
  const { read, body } = counting(4096, 10_000);
  const response = await ingress(streamed(body));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: 'invalid-request',
    detail: expect.stringContaining('exceeds'),
  });
  // Reading stopped at the ceiling plus the chunk that crossed it, not at the end of 40 MB.
  expect(read.chunks * 4096).toBeLessThanOrEqual(ceiling + 2 * 4096);
  expect(received).toHaveLength(0);
});

test('a declared content-length past the ceiling is refused before any byte is read', async () => {
  const { ingress, received } = owner();
  const ceiling = jsonEnvelopeBytes(256);
  const { read, body } = counting(1024, 4);
  const response = await ingress(streamed(body, { 'content-length': String(ceiling + 1) }));
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ detail: expect.stringContaining('exceeds') });
  expect(read.chunks).toBe(0);
  expect(received).toHaveLength(0);
});

test('an envelope that is not UTF-8 is refused, and the payload limit counts bytes, not characters', async () => {
  const { ingress, received } = owner();
  const refused = await ingress(post('\u0000', { 'content-type': 'application/json' }));
  expect(refused.status).toBe(400);
  const invalidUtf8 = new Request('http://owner.invalid/invoke', {
    method: 'POST',
    body: new Uint8Array([0x7b, 0xff, 0x7d]),
  });
  expect((await ingress(invalidUtf8)).status).toBe(400);
  // 'ж' is two bytes: 40 of them are 42 characters but 82 bytes of JSON text, past this operation's 64.
  const wide = JSON.stringify(envelope({ payload: JSON.stringify('ж'.repeat(40)) }));
  expect((await ingress(post(wide))).status).toBe(400);
  const narrow = JSON.stringify(envelope({ payload: JSON.stringify('ж'.repeat(20)) }));
  expect((await ingress(post(narrow))).status).toBe(200);
  expect(received).toHaveLength(1);
});

test('a request that is not a POST envelope is refused', async () => {
  const { ingress, received } = owner();
  const response = await ingress(new Request('http://owner.invalid/invoke'));
  expect(response.status).toBe(400);
  expect(received).toHaveLength(0);
});

test('a caller header sent straight to the handler, or a copy of a delivered request, carries no caller', async () => {
  const { ingress, received } = owner();
  await ingress(post(JSON.stringify(envelope())));
  const delivered = reached(received);
  expect(serviceCaller({ req: delivered })).toBeDefined();
  const forged = new Request('http://owner.invalid/catalog/lookup', {
    method: 'POST',
    headers: { 'x-stitchwire-caller': 'operator', 'x-stitchwire-trace-id': crypto.randomUUID() },
    body: '{}',
  });
  expect(serviceCaller({ req: forged })).toBeUndefined();
  // The Bun and undici Request types differ only in typings; both are the one global class.
  const copies = [delivered.clone(), new Request(delivered as never)] as unknown as Request[];
  for (const copy of copies) expect(serviceCaller({ req: copy })).toBeUndefined();
});

test('the node dropping the connection aborts the request the handler holds', async () => {
  const { ingress, received } = owner();
  const controller = new AbortController();
  await ingress(post(JSON.stringify(envelope()), {}, controller.signal));
  const forwarded = reached(received);
  expect(forwarded.signal.aborted).toBe(false);
  controller.abort();
  expect(forwarded.signal.aborted).toBe(true);
});

test('a descriptor the node would refuse, or a handler that is not a function, is refused when the ingress is made', () => {
  expect(() =>
    createServiceIngress({ descriptor: { ...descriptor, operations: [] }, handler: () => new Response() }),
  ).toThrow(ZodError);
  expect(() => createServiceIngress({ descriptor, handler: 'not a function' as never })).toThrow(TypeError);
});

/** A body that never produces a byte; `cancelled` settles when the reader gives it up. */
function stuck() {
  let cancel: (reason: unknown) => void = () => {};
  const cancelled = new Promise<unknown>((resolve) => {
    cancel = resolve;
  });
  const body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel });
  return { body, cancelled };
}

function ownerWith(bodyTimeoutMs: number | undefined, source: ServiceDescriptor = descriptor) {
  const received: Request[] = [];
  const ingress = createServiceIngress({
    descriptor: source,
    handler: (request) => {
      received.push(request);
      return new Response('{"ok":true}');
    },
    bodyTimeoutMs,
  });
  return { ingress, received };
}

const DEADLINE_DETAIL = 'service envelope was not read within its deadline';

test('a body that does not arrive within bodyTimeoutMs is cancelled and refused without reaching the handler', async () => {
  const { ingress, received } = ownerWith(20);
  const { body, cancelled } = stuck();
  const response = await ingress(streamed(body));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'invalid-request', detail: DEADLINE_DETAIL });
  // The source was released, not left to the garbage collector.
  await cancelled;
  expect(received).toHaveLength(0);
});

test('the node dropping the connection while the envelope is read is not reported as the deadline', async () => {
  const { ingress, received } = ownerWith(10_000);
  const { body, cancelled } = stuck();
  const controller = new AbortController();
  const pending = ingress(
    new Request('http://owner.invalid/invoke', {
      method: 'POST',
      body,
      signal: controller.signal,
      ...({ duplex: 'half' } as object),
    }),
  );
  controller.abort();
  const response = await pending;
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'invalid-request',
    detail: 'service envelope could not be read',
  });
  await cancelled;
  expect(received).toHaveLength(0);
});

test('without the option the deadline is the longest budget the descriptor declares, a stream counting its lifetime', async () => {
  const quick: ServiceDescriptor = {
    ...descriptor,
    operations: descriptor.operations.map((operation) => ({
      ...operation,
      limits: { ...operation.limits, timeoutMs: 50 },
    })),
  };
  const { ingress } = ownerWith(undefined, quick);
  const { body, cancelled } = stuck();
  const response = await ingress(streamed(body));
  expect(await response.json()).toMatchObject({ detail: DEADLINE_DETAIL });
  await cancelled;

  // A stream living longer than its unary budget keeps the read open for that lifetime.
  const living: ServiceDescriptor = {
    ...quick,
    operations: quick.operations.map((operation) =>
      operation.response.kind === 'stream'
        ? { ...operation, response: { kind: 'stream' as const, lifetimeMs: 10_000 } }
        : operation,
    ),
  };
  // The deadline armed for a read is observable as the delay handed to the timer.
  const timer = spyOn(globalThis, 'setTimeout');
  try {
    expect((await ownerWith(undefined, living).ingress(post(JSON.stringify(envelope())))).status).toBe(200);
    expect(timer.mock.calls.map(([, delay]) => delay)).toContain(10_000);
  } finally {
    timer.mockRestore();
  }
});

test('bodyTimeoutMs must be an integer from 1 to the service timeout ceiling', () => {
  for (const invalid of [0, -1, 1.5, Number.NaN, 30_001])
    expect(() => ownerWith(invalid), String(invalid)).toThrow(ZodError);
  // A JavaScript caller can pass a string, which the option's schema refuses.
  // @ts-expect-error the option is typed as a number
  expect(() => ownerWith('50')).toThrow(ZodError);
  expect(() => ownerWith(1)).not.toThrow();
  expect(() => ownerWith(30_000)).not.toThrow();
});

test('the deadline reads the body once: nothing is teed or cloned', async () => {
  const tee = spyOn(ReadableStream.prototype, 'tee');
  const clone = spyOn(Request.prototype, 'clone');
  try {
    const { ingress, received } = ownerWith(20);
    expect((await ingress(post(JSON.stringify(envelope())))).status).toBe(200);
    const { body } = stuck();
    expect((await ingress(streamed(body))).status).toBe(400);
    expect(received).toHaveLength(1);
    expect(tee).not.toHaveBeenCalled();
    expect(clone).not.toHaveBeenCalled();
  } finally {
    tee.mockRestore();
    clone.mockRestore();
  }
});

test('the deadline ends with the read: the handler and the forwarded signal are not under it', async () => {
  const { ingress, received } = ownerWith(20);
  await ingress(post(JSON.stringify(envelope())));
  const forwarded = reached(received);
  // Well past the deadline the forwarded request is still live; only the node's own abort ends it.
  await Bun.sleep(60);
  expect(forwarded.signal.aborted).toBe(false);
});
