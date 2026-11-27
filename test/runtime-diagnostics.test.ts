import { expect, spyOn, test } from 'bun:test';
import { getRequestContext, wrapInRequestContext } from 'stitchkit/observability';
import { createHandler } from 'stitchkit/server';
import { wireLogger } from '../packages/runtime/src/logger.ts';
import { createLocalServiceRoute } from '../packages/runtime/src/service/local.ts';
import { serviceFailure } from '../packages/contracts/src/service/contracts.ts';

test('runtime stderr bounds and redacts diagnostics without losing ordinary facts', () => {
  const output: unknown[][] = [];
  const sink = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    output.push(args);
  });
  try {
    wireLogger.error('owner failed', {
      id: 'operation-17',
      token: 'fixture-token-secret',
      nested: { authorization: 'fixture-auth-secret' },
      url: 'https://user:fixture-password@example.invalid/read?token=fixture-query-secret',
      error: new Error('owner unavailable'),
    });
    const text = JSON.stringify(output);
    expect(text).toContain('operation-17');
    expect(text).toContain('owner unavailable');
    for (const secret of [
      'fixture-token-secret',
      'fixture-auth-secret',
      'fixture-password',
      'fixture-query-secret',
    ])
      expect(text).not.toContain(secret);
    wireLogger.error('oversized', { value: 'x'.repeat(200_000) });
    expect(Buffer.byteLength(JSON.stringify(output[1]))).toBeLessThan(66_000);
    sink.mockImplementation(() => {
      throw new Error('stderr unavailable');
    });
    expect(() => wireLogger.error('still settles', { token: 'fixture-token-secret' })).not.toThrow();
  } finally {
    sink.mockRestore();
  }
});

test('service raw door attributes both valid and rejected bodies to its contract operation', async () => {
  let calls = 0;
  const route = createLocalServiceRoute({
    invokeService: async () => {
      calls += 1;
      return serviceFailure('unsupported');
    },
  });
  const identities: unknown[] = [];
  const handler = createHandler({
    rawRoutes: [
      {
        ...route,
        handler: (request, context) => {
          const active = getRequestContext();
          identities.push({ service: active?.serviceName, action: active?.action });
          return route.handler(request, { params: context.params });
        },
      },
    ],
  });
  const fetch = wrapInRequestContext(async (request: Request) => handler(request));
  const valid = JSON.stringify({
    to: 'worker',
    service: 'example.catalog',
    revision: '1',
    operation: 'query',
    payload: '{}',
    timeoutMs: 1000,
  });
  for (const body of [valid, '{']) {
    const response = await fetch(
      new Request(`http://wire.invalid${route.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      }),
      undefined,
    );
    expect(response.status).toBe(body === valid ? 200 : 400);
  }
  expect(calls).toBe(1);
  expect(identities).toEqual([
    { service: 'wire', action: 'invokeService' },
    { service: 'wire', action: 'invokeService' },
  ]);
});
