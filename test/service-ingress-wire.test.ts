import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { ServiceDescriptor } from '../packages/contracts/src/service/policy-schema.ts';
import { type DoorStand, startDoorStand } from './door-stand.ts';
import { until } from './support.ts';

/*
 * The read deadline of `createServiceIngress` as a service owner meets it: the owner serves the ingress
 * on its Unix socket, a caller reaches it through a broker and two agents, and the deadline is far
 * shorter than the calls it must not cut. Nothing asserts how long anything took (ADR 0012).
 */

/** Shorter than every call below; the deadline covers the envelope read and nothing after it. */
const BODY_TIMEOUT_MS = 50;
/** Longer than the deadline by a wide margin, so a deadline that wrongly outlived the read would cut the call. */
const PAST_DEADLINE_MS = 4 * BODY_TIMEOUT_MS;

const descriptor: ServiceDescriptor = {
  service: 'example.deadline',
  revision: '1',
  maxInflight: 4,
  operations: [
    {
      id: 'wait',
      path: '/deadline/wait',
      effect: 'read',
      limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 20_000 },
      response: { kind: 'unary' },
    },
    {
      id: 'follow',
      path: '/deadline/follow',
      effect: 'read',
      limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 20_000 },
      response: { kind: 'stream', lifetimeMs: 20_000 },
    },
    {
      id: 'hold',
      path: '/deadline/hold',
      effect: 'read',
      limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 20_000 },
      response: { kind: 'unary' },
    },
  ],
};

const reached: string[] = [];
const held: { signal?: AbortSignal } = {};
const frames = ['one\n', 'two\n', 'three\n', 'four\n'];

async function owner(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  reached.push(pathname);
  if (pathname === '/deadline/wait') {
    await Bun.sleep(PAST_DEADLINE_MS);
    // A deadline that reached the handler would show here as an aborted request.
    return new Response(request.signal.aborted ? '{"answered":"cut"}' : '{"answered":"late"}', {
      headers: { 'content-type': 'application/json' },
    });
  }
  if (pathname === '/deadline/follow') {
    const encoder = new TextEncoder();
    let sent = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const frame = frames[sent];
          if (frame === undefined) return controller.close();
          sent += 1;
          await Bun.sleep(PAST_DEADLINE_MS / frames.length);
          controller.enqueue(encoder.encode(frame));
        },
      }),
      { headers: { 'content-type': 'application/x-ndjson' } },
    );
  }
  held.signal = request.signal;
  await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve()));
  return new Response('{}', { headers: { 'content-type': 'application/json' } });
}

let stand: DoorStand;

beforeAll(async () => {
  stand = await startDoorStand({ descriptor, owner, bodyTimeoutMs: BODY_TIMEOUT_MS });
});

afterAll(async () => {
  await stand?.stop();
});

const post = (path: string, signal?: AbortSignal) => stand.post(path, signal);

test('a unary handler that answers long after the deadline is answered through the broker', async () => {
  const response = await post('/deadline/wait');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ answered: 'late' });
});

test('a stream that keeps sending past the deadline is read to its end', async () => {
  const response = await post('/deadline/follow');
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(frames.join(''));
});

test('the caller withdrawing reaches the handler as an aborted request signal', async () => {
  const withdrawal = new AbortController();
  const pending = post('/deadline/hold', withdrawal.signal).catch(() => undefined);
  expect(await until(() => held.signal !== undefined)).toBe(true);
  expect(held.signal?.aborted).toBe(false);
  withdrawal.abort();
  expect(await until(() => held.signal?.aborted === true)).toBe(true);
  await pending;
});

/**
 * A slow body cannot be made through a broker: the agent writes the whole envelope in one piece. The
 * owner's own socket is the door a slow or stalled sender reaches, so the test speaks HTTP to it.
 */
test('a sender that stalls inside the envelope on the owner socket is refused and the handler is not called', async () => {
  const before = reached.length;
  let received = '';
  const answered = Promise.withResolvers<void>();
  const socket = await Bun.connect({
    unix: stand.ownerSocket,
    socket: {
      open(connection) {
        // Chunked, so the owner sees the head and the first bytes of a body that never completes.
        connection.write(
          'POST /invoke HTTP/1.1\r\nHost: owner\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n',
        );
        connection.write('6\r\n{"v":1\r\n');
      },
      data(_connection, chunk) {
        received += chunk.toString();
        if (received.includes('}')) answered.resolve();
      },
      close() {
        answered.resolve();
      },
      error() {
        answered.resolve();
      },
    },
  });
  try {
    await answered.promise;
    expect(received).toContain('400');
    expect(received).toContain('service envelope was not read within its deadline');
    expect(reached).toHaveLength(before);
  } finally {
    socket.end();
  }
});
