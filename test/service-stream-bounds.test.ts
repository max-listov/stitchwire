import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { LocalStreamRequestSchema } from '../packages/contracts/src/door/requests.ts';
import { StreamOpenSchema } from '../packages/contracts/src/protocol/stream.ts';
import { ServiceDescriptorSchema } from '../packages/contracts/src/service/policy-schema.ts';
import { serviceOperationTimeout } from '../packages/contracts/src/service/budgets.ts';
import { type DoorStand, startDoorStand } from './door-stand.ts';
import { until } from './support.ts';

/**
 * Any stream operation a descriptor accepts must be one the door accepts: a service owner declares
 * its own stream lifetime, and a descriptor that parses but cannot be called is a trap.
 */
const descriptor = ServiceDescriptorSchema.parse({
  service: 'example.feed',
  revision: '1',
  maxInflight: 1,
  operations: [
    {
      id: 'follow',
      path: '/feed/follow',
      effect: 'read',
      limits: { requestBytes: 64, responseBytes: 1024, timeoutMs: 500 },
      response: { kind: 'stream', lifetimeMs: 500 },
    },
  ],
});

test('a stream lifetime the descriptor accepts is a request the door accepts, and the wire accepts it too', () => {
  const [operation] = descriptor.operations;
  if (operation === undefined) throw new Error('no operation');
  const timeoutMs = serviceOperationTimeout(operation);
  expect(timeoutMs).toBe(500);
  const request = {
    to: 'worker',
    source: { kind: 'service', service: 'example.feed', revision: '1', operation: 'follow', payload: '{}' },
    timeoutMs,
  };
  expect(LocalStreamRequestSchema.safeParse(request).success).toBe(true);
  expect(
    StreamOpenSchema.safeParse({
      streamId: crypto.randomUUID(),
      ts: new Date().toISOString(),
      from: 'reader',
      to: 'worker',
      source: request.source,
      timeoutMs,
      requestedWindowBytes: 1024,
    }).success,
  ).toBe(true);
});

/**
 * The same descriptor, served for real: an owner behind a worker agent, a broker, a reader agent and a
 * client on the reader's door. The lifetime of 500 ms is below the one second a command profile may not go
 * under, and a stream operation is not a command profile.
 */
const aborted: Record<string, boolean> = {};
const owner = (request: Request): Response => {
  const { pathname } = new URL(request.url);
  if (pathname === '/feed/follow')
    return new Response('line\n', { headers: { 'content-type': 'application/x-ndjson' } });
  // Never ends on its own: only the declared lifetime can finish it.
  request.signal.addEventListener('abort', () => {
    aborted[pathname] = true;
  });
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first\n'));
      },
    }),
    { headers: { 'content-type': 'application/x-ndjson' } },
  );
};

describe('a stream whose lifetime is under a second, through a broker and the client', () => {
  let stand: DoorStand;
  beforeAll(async () => {
    const [follow] = descriptor.operations;
    if (follow === undefined) throw new Error('no operation');
    stand = await startDoorStand({
      descriptor: {
        ...descriptor,
        operations: [follow, { ...follow, id: 'endless', path: '/feed/endless' }],
      },
      owner,
    });
  });
  afterAll(async () => {
    await stand?.stop();
  });

  test('is callable and delivers what the owner sent', async () => {
    const response = await stand.post('/feed/follow');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('line\n');
  });

  test('ends when its lifetime is over, and the owner is told to stop', async () => {
    const response = await stand.post('/feed/endless');
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('the response has no body');
    const received: string[] = [];
    // The body ends, or fails, once the lifetime is over; a stream that never ended would hang here.
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (next.done) break;
      received.push(new TextDecoder().decode(next.value));
    }
    expect(received.join('')).toBe('first\n');
    expect(await until(() => aborted['/feed/endless'] === true)).toBe(true);
  }, 30_000);
});
