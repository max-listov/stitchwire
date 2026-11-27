import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { ServiceExecutor } from '../packages/runtime/src/service/executor.ts';
import { ServicePolicySchema } from '../packages/contracts/src/service/policy-schema.ts';
import { bindUnixSocket } from 'stitchkit/files';

test('owner response bound has the same typed failure with Content-Length and streamed bytes', async () => {
  const root = await mkdtemp('/tmp/wire-owner-bound-');
  const socket = `${root}/owner.sock`;
  const descriptorPath = `${root}/descriptor.json`;
  const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 };
  await writeFile(
    descriptorPath,
    JSON.stringify({
      service: 'example.read',
      revision: '1',
      maxInflight: 1,
      operations: [{ id: 'read', path: '/read', effect: 'read', limits, response: { kind: 'unary' } }],
    }),
  );
  let bytes = 4096;
  let chunked = false;
  const owner = bindUnixSocket({ path: socket, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      fetch() {
        const payload = JSON.stringify('x'.repeat(bytes - 2));
        return new Response(
          chunked
            ? new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode(payload));
                  controller.close();
                },
              })
            : payload,
          { headers: { 'content-type': 'application/json' } },
        );
      },
    }),
  );
  const executor = new ServiceExecutor(
    ServicePolicySchema.parse({
      bindings: [
        {
          service: 'example.read',
          descriptorPath,
          socketPath: socket,
          endpointPath: '/invoke',
          maxInflight: 1,
          limits,
        },
      ],
      grants: [
        { caller: 'reader', target: 'owner', service: 'example.read', scope: { kind: 'service-read' } },
      ],
    }),
    'owner',
  );
  const call = () =>
    executor.execute(
      {
        id: crypto.randomUUID(),
        from: 'reader',
        to: 'owner',
        service: 'example.read',
        revision: '1',
        operation: 'read',
        payload: '{}',
        timeoutMs: 2000,
      },
      new AbortController().signal,
    );
  try {
    for (const mode of [false, true]) {
      chunked = mode;
      bytes = 4096;
      const legal = await call();
      expect(legal.status).toBe('response');
      if (legal.status !== 'response') throw new Error('legal owner response rejected');
      expect(Buffer.byteLength(legal.payload)).toBe(4096);
      bytes = 4097;
      expect(await call()).toMatchObject({
        status: 'failure',
        code: 'invalid-response',
        delivery: 'unknown',
      });
      bytes = 4096;
      expect((await call()).status).toBe('response');
    }
  } finally {
    owner.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
