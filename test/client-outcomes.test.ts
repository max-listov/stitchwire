import { expect, test } from 'bun:test';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';
import { UnixClientTransportError } from 'stitchkit/server';
import { localError, WireClientError } from '../packages/local-client/src/errors.ts';
import type { WireFeed } from '../packages/local-client/src/feed.ts';
import type { StreamItem } from '../packages/local-client/src/readers.ts';
import {
  CallResultSchema,
  PublishResultSchema,
  StatusResultSchema,
  readResponse,
  readEventItem,
  readStreamItem,
} from '../packages/local-client/src/readers.ts';
import { createServiceFetch, WireServiceError } from '../packages/local-client/src/service.ts';
import { ServiceOutcomeSchema } from '../packages/contracts/src/service/contracts.ts';
import { ServiceDescriptorSchema } from '../packages/contracts/src/service/policy-schema.ts';
import { status as statusFixture } from './doctor-fixture.ts';

const fields = {
  failure: 'denied',
  refusal: 'capacity',
  retryAfterMs: 250,
  transportCause: null,
  detail: 'opaque detail',
};
const call = {
  v: LOCAL_API_VERSION,
  id: crypto.randomUUID(),
  ts: '',
  from: 'worker',
  code: 1,
  stdout: '',
  stderr: '',
  truncated: false,
  ...fields,
};
const event = {
  v: LOCAL_API_VERSION,
  subscriptionId: null,
  topic: 'example.events',
  from: 'broker',
  ...fields,
};
const stream = {
  v: LOCAL_API_VERSION,
  streamId: crypto.randomUUID(),
  from: 'worker',
  reason: 'error',
  ...fields,
};

test('call, publish and feed outcomes retain refusal hints and terminal reason', () => {
  expect<unknown>(CallResultSchema.parse({ ...call, additive: true })).toEqual(call);
  expect<unknown>(PublishResultSchema.parse({ ok: false, ...fields })).toEqual({ ok: false, ...fields });
  expect<unknown>(readEventItem(event)).toEqual({ kind: 'error', frame: event });
  expect<unknown>(readStreamItem(stream)).toEqual({ kind: 'error', frame: stream });
  const deadline = {
    v: LOCAL_API_VERSION,
    streamId: stream.streamId,
    from: 'worker',
    lastSeq: -1,
    code: 0,
    reason: 'timeout',
    cursor: null,
  };
  expect<unknown>(readStreamItem(deadline)).toEqual({ kind: 'end', frame: deadline });
});

test('required classification cannot silently default; contradictions fail', () => {
  for (const change of [
    { refusal: undefined },
    { retryAfterMs: undefined },
    { failure: undefined },
    { refusal: 'policy', retryAfterMs: 250 },
    { failure: 'none', refusal: 'capacity' },
  ]) {
    expect(CallResultSchema.safeParse({ ...call, ...change }).success).toBe(false);
    expect(() => readEventItem({ ...event, ...change })).toThrow();
    expect(() => readStreamItem({ ...stream, ...change })).toThrow();
  }
});

test('local readers reject a missing transport cause', () => {
  const { transportCause: _callCause, ...oldCall } = call;
  const { transportCause: _eventCause, ...oldEvent } = event;
  const { transportCause: _streamCause, ...oldStream } = stream;
  expect(CallResultSchema.safeParse(oldCall).success).toBe(false);
  expect(() => readEventItem(oldEvent)).toThrow();
  expect(() => readStreamItem(oldStream)).toThrow();
});

test('status rejects the previous local door version before parsing its shape', () => {
  expect(() => readResponse(StatusResultSchema, { ...statusFixture(), v: 4 })).toThrow(
    'Unsupported local Wire door version',
  );
});

test('status rejects every required runtime observation when absent', () => {
  const status = statusFixture();
  for (const field of ['publicationAudit', 'admission', 'config', 'release', 'application'] as const) {
    const incomplete = { ...status };
    delete incomplete[field];
    expect(StatusResultSchema.safeParse(incomplete).success).toBe(false);
  }
  const lane = { ...status.lanes[0] };
  delete lane.lastFailure;
  expect(StatusResultSchema.safeParse({ ...status, lanes: [lane] }).success).toBe(false);
  for (const field of ['subscriptions', 'topics', 'observedAt']) {
    const events = Object.fromEntries(Object.entries(status.events).filter(([key]) => key !== field));
    expect(StatusResultSchema.safeParse({ ...status, events }).success).toBe(false);
  }
});

test('transport delivery and original cause survive SDK mapping', () => {
  for (const delivery of ['not-dispatched', 'possibly-dispatched', 'response-received']) {
    if (
      delivery !== 'not-dispatched' &&
      delivery !== 'possibly-dispatched' &&
      delivery !== 'response-received'
    )
      throw new Error();
    const cause = new UnixClientTransportError('UNIX_RESPONSE_ABORTED', 'internal', delivery);
    const error = localError(cause, 'unknown');
    expect(error).toBeInstanceOf(WireClientError);
    expect(error.delivery).toBe(delivery === 'not-dispatched' ? 'not-sent' : 'unknown');
    expect(error.cause).toBe(cause);
  }
});

test('one typed transport cause survives call, publish, feed and service SDK boundaries', () => {
  const transport = {
    failure: 'offline',
    refusal: 'none',
    retryAfterMs: null,
    transportCause: 'target-offline',
    detail: 'human explanation can change',
  };
  const transportCall = { ...call, ...transport };
  const transportEvent = { ...event, ...transport };
  const transportStream = { ...stream, ...transport };
  expect(CallResultSchema.parse(transportCall).transportCause).toBe('target-offline');
  expect(PublishResultSchema.parse({ ok: false, ...transport }).transportCause).toBe('target-offline');
  const eventItem = readEventItem(transportEvent);
  expect(eventItem.kind === 'error' ? eventItem.frame.transportCause : null).toBe('target-offline');
  const streamItem = readStreamItem(transportStream);
  expect(streamItem.kind === 'error' ? streamItem.frame.transportCause : null).toBe('target-offline');
  const serviceError = new WireServiceError({
    status: 'failure',
    code: 'offline',
    delivery: 'not-dispatched',
    retryAfterMs: null,
    refusal: 'none',
    transportCause: 'target-offline',
  });
  expect(serviceError.transportCause).toBe('target-offline');
});

test('transport causes reject failure and delivery combinations that cannot occur', () => {
  const rpcBase = {
    ...call,
    failure: 'offline',
    refusal: 'none',
    retryAfterMs: null,
    transportCause: 'target-offline',
  };
  expect(CallResultSchema.safeParse(rpcBase).success).toBe(true);
  expect(CallResultSchema.safeParse({ ...rpcBase, failure: 'timeout' }).success).toBe(false);

  const serviceBase = {
    status: 'failure',
    code: 'unavailable',
    delivery: 'not-dispatched',
    retryAfterMs: null,
    refusal: 'none',
    transportCause: 'no-connected-lane',
  };
  expect(ServiceOutcomeSchema.safeParse(serviceBase).success).toBe(true);
  expect(ServiceOutcomeSchema.safeParse({ ...serviceBase, delivery: 'unknown' }).success).toBe(false);
  expect(
    ServiceOutcomeSchema.safeParse({
      ...serviceBase,
      delivery: 'not-dispatched',
      transportCause: 'lane-lost-after-dispatch',
    }).success,
  ).toBe(false);
  expect(
    ServiceOutcomeSchema.safeParse({
      ...serviceBase,
      code: 'timeout',
      delivery: 'unknown',
      transportCause: 'acknowledgement-timeout',
    }).success,
  ).toBe(true);
});

const serviceDescriptor = ServiceDescriptorSchema.parse({
  service: 'test.stream',
  revision: '1',
  maxInflight: 1,
  operations: [
    {
      id: 'follow',
      path: '/service/1/follow',
      effect: 'read',
      limits: { requestBytes: 4, responseBytes: 1024, timeoutMs: 1000 },
      response: { kind: 'stream' },
    },
  ],
});

test('service adapter rejects an incomplete client at creation', () => {
  expect(() =>
    createServiceFetch({ invokeService: async () => ({}) } as never, {
      to: 'worker',
      baseUrl: 'https://owner.invalid',
      descriptor: serviceDescriptor,
    }),
  ).toThrow('invokeService and stream');
});

test('service adapter refuses a request body that is not UTF-8 instead of replacing bytes', async () => {
  let called = false;
  const fetch = createServiceFetch(
    {
      invokeService: async () => {
        called = true;
        throw new Error('the call must not be made');
      },
      stream: () => {
        called = true;
        throw new Error('the call must not be made');
      },
    },
    { to: 'worker', baseUrl: 'https://owner.invalid', descriptor: serviceDescriptor },
  );
  const error = await fetch('https://owner.invalid/service/1/follow', {
    method: 'POST',
    body: new Uint8Array([0x22, 0xff, 0x22]),
  }).then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(WireServiceError);
  expect(error).toMatchObject({ outcome: { code: 'invalid-request', delivery: 'not-dispatched' } });
  expect(called).toBe(false);
});

test('service adapter answers a body that is not a JSON document with the same error class as an oversize one', async () => {
  const fetch = createServiceFetch(
    {
      invokeService: async () => {
        throw new Error('the call must not be made');
      },
      stream: () => {
        throw new Error('the call must not be made');
      },
    },
    { to: 'worker', baseUrl: 'https://owner.invalid', descriptor: serviceDescriptor },
  );
  for (const body of ['', 'not json']) {
    const error = await fetch('https://owner.invalid/service/1/follow', { method: 'POST', body }).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(WireServiceError);
    expect(error).toMatchObject({ outcome: { code: 'invalid-request', delivery: 'not-dispatched' } });
  }
});

function oneItemFeed(item: StreamItem): WireFeed<StreamItem> {
  let read = false;
  const feed: WireFeed<StreamItem> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (read) return { done: true, value: undefined };
      read = true;
      return { done: false, value: item };
    },
    async return() {
      read = true;
      return { done: true, value: undefined };
    },
    close() {
      read = true;
    },
  };
  return feed;
}

test('service stream adapter preserves classified refusal and delivery semantics', async () => {
  const item: StreamItem = {
    kind: 'error',
    frame: {
      v: LOCAL_API_VERSION,
      streamId: crypto.randomUUID(),
      from: 'broker',
      failure: 'denied',
      refusal: 'capacity',
      retryAfterMs: 123,
      transportCause: null,
      reason: 'limit',
      detail: 'busy',
    },
  };
  const fetch = createServiceFetch(
    {
      invokeService: async () => {
        throw new Error('unary path must not run');
      },
      stream: () => oneItemFeed(item),
    },
    {
      to: 'worker',
      baseUrl: 'https://owner.invalid',
      descriptor: serviceDescriptor,
    },
  );
  const response = await fetch('https://owner.invalid/service/1/follow', {
    method: 'POST',
    body: '{}',
  });
  try {
    await response.text();
    throw new Error('stream should fail');
  } catch (error) {
    expect(error).toBeInstanceOf(WireServiceError);
    if (!(error instanceof WireServiceError)) throw error;
    expect(error.outcome).toEqual({
      status: 'failure',
      code: 'capacity',
      delivery: 'not-dispatched',
      retryAfterMs: 123,
      transportCause: null,
      refusal: 'capacity',
      detail: 'busy',
    });
  }
});

test('service stream adapter maps every terminal class without prose matching', async () => {
  const streamId = crypto.randomUUID();
  const cases: Array<{
    item: StreamItem;
    expected: Partial<WireServiceError['outcome']>;
  }> = [
    {
      item: {
        kind: 'error',
        frame: {
          v: LOCAL_API_VERSION,
          streamId,
          from: 'broker',
          failure: 'denied',
          refusal: 'policy',
          retryAfterMs: null,
          transportCause: null,
          reason: 'unsupported',
          detail: 'forbidden',
        },
      },
      expected: { code: 'denied', delivery: 'not-dispatched', refusal: 'policy' },
    },
    {
      item: {
        kind: 'error',
        frame: {
          v: LOCAL_API_VERSION,
          streamId,
          from: 'broker',
          failure: 'transport',
          refusal: 'none',
          retryAfterMs: null,
          transportCause: 'no-connected-lane',
          reason: 'disconnect',
          detail: 'route absent',
        },
      },
      expected: {
        code: 'unavailable',
        delivery: 'not-dispatched',
        transportCause: 'no-connected-lane',
      },
    },
    {
      item: {
        kind: 'end',
        frame: {
          v: LOCAL_API_VERSION,
          streamId,
          from: 'worker',
          lastSeq: -1,
          code: 0,
          reason: 'timeout',
          cursor: null,
        },
      },
      expected: { code: 'timeout', delivery: 'unknown', refusal: 'none' },
    },
    {
      item: {
        kind: 'end',
        frame: {
          v: LOCAL_API_VERSION,
          streamId,
          from: 'worker',
          lastSeq: -1,
          code: 0,
          reason: 'cancelled',
          cursor: null,
        },
      },
      expected: { code: 'cancelled', delivery: 'unknown', refusal: 'none' },
    },
  ];
  for (const { item, expected } of cases) {
    const fetch = createServiceFetch(
      {
        invokeService: async () => {
          throw new Error('unary path must not run');
        },
        stream: () => oneItemFeed(item),
      },
      {
        to: 'worker',
        baseUrl: 'https://owner.invalid',
        descriptor: serviceDescriptor,
      },
    );
    const response = await fetch('https://owner.invalid/service/1/follow', {
      method: 'POST',
      body: '{}',
    });
    try {
      await response.text();
      throw new Error('stream should fail');
    } catch (error) {
      expect(error).toBeInstanceOf(WireServiceError);
      if (!(error instanceof WireServiceError)) throw error;
      expect(error.outcome).toMatchObject(expected);
    }
  }
});

test('service fetch cancels a chunked request at the first byte beyond its bound', async () => {
  let pulls = 0;
  let dispatched = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls === 1) controller.enqueue(new TextEncoder().encode('1234'));
      else if (pulls === 2) controller.enqueue(new TextEncoder().encode('5'));
      else controller.close();
    },
  });
  const fetch = createServiceFetch(
    {
      invokeService: async () => {
        dispatched = true;
        throw new Error('oversized request must not dispatch');
      },
      stream: () => {
        throw new Error('oversized request must not dispatch');
      },
    },
    {
      to: 'worker',
      baseUrl: 'https://owner.invalid',
      descriptor: serviceDescriptor,
    },
  );
  await expect(
    fetch(
      new Request('https://owner.invalid/service/1/follow', {
        method: 'POST',
        body,
      }),
    ),
  ).rejects.toMatchObject({
    outcome: { code: 'invalid-request', delivery: 'not-dispatched', refusal: 'request' },
  });
  expect(pulls).toBeLessThanOrEqual(3);
  expect(dispatched).toBe(false);
});

test('service fetch aborts body consumption before dispatch', async () => {
  let dispatched = false;
  const body = new ReadableStream<Uint8Array>();
  const controller = new AbortController();
  const fetch = createServiceFetch(
    {
      invokeService: async () => {
        dispatched = true;
        throw new Error('cancelled request must not dispatch');
      },
      stream: () => {
        throw new Error('cancelled request must not dispatch');
      },
    },
    {
      to: 'worker',
      baseUrl: 'https://owner.invalid',
      descriptor: serviceDescriptor,
    },
  );
  const pending = fetch(
    new Request('https://owner.invalid/service/1/follow', {
      method: 'POST',
      body,
      signal: controller.signal,
    }),
  );
  controller.abort();
  await expect(pending).rejects.toMatchObject({
    outcome: { code: 'cancelled', delivery: 'not-dispatched', cancellationOrigin: 'caller-abort' },
  });
  expect(dispatched).toBe(false);
});
