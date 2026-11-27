import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile, rename, readFile } from 'node:fs/promises';
import { ServicePolicySchema } from '../packages/contracts/src/service/policy-schema.ts';
import { ServiceExecutor } from '../packages/runtime/src/service/executor.ts';
import { bindUnixSocket } from 'stitchkit/files';

test('stream opening, post-open lifetime and cancellation have separate bounded ownership', async () => {
  const root = await mkdtemp('/tmp/wire-stream-budget-');
  const socketPath = `${root}/owner.sock`;
  const descriptorPath = `${root}/descriptor.json`;
  let openingDelay = 200;
  const owner = bindUnixSocket({ path: socketPath, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      async fetch() {
        await Bun.sleep(openingDelay);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('opened\n'));
            },
          }),
        );
      },
    }),
  );
  await writeFile(
    descriptorPath,
    JSON.stringify({
      service: 'example.feed',
      revision: '1',
      maxInflight: 1,
      operations: [
        {
          id: 'follow',
          path: '/follow',
          effect: 'read',
          limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 1000 },
          response: { kind: 'stream', lifetimeMs: 30000 },
        },
      ],
    }),
  );
  const executor = new ServiceExecutor(
    ServicePolicySchema.parse({
      bindings: [
        {
          service: 'example.feed',
          descriptorPath,
          socketPath,
          endpointPath: '/service',
          maxInflight: 1,
          limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 30000 },
        },
      ],
      grants: [
        { caller: 'reader', target: 'worker', service: 'example.feed', scope: { kind: 'service-read' } },
      ],
    }),
    'worker',
  );
  const call = {
    id: crypto.randomUUID(),
    from: 'reader',
    to: 'worker',
    service: 'example.feed',
    revision: '1',
    operation: 'follow',
    payload: '{}',
    timeoutMs: 400,
  };
  try {
    const opened = await executor.openStream(call, new AbortController().signal);
    if (!opened.accepted) throw new Error(JSON.stringify(opened.outcome));
    const afterHeaders = performance.now();
    const capacity = async () => {
      const second = await executor.openStream(call, new AbortController().signal);
      if (second.accepted) await second.close();
      expect(second).toMatchObject({ accepted: false, outcome: { code: 'capacity' } });
    };
    await capacity();
    const original = await readFile(descriptorPath);
    await writeFile(`${descriptorPath}.next`, original);
    await rename(`${descriptorPath}.next`, descriptorPath);
    await capacity();

    const reader = opened.response.body?.getReader();
    if (!reader) throw new Error('missing stream body');
    expect((await reader.read()).done).toBe(false);
    await expect(reader.read()).rejects.toThrow();
    expect(performance.now() - afterHeaders).toBeGreaterThanOrEqual(350);
    expect(opened.timedOut()).toBe(true);
    reader.releaseLock();
    await opened.close();

    openingDelay = 0;
    const cancellation = new AbortController();
    const cancelled = await executor.openStream({ ...call, timeoutMs: 30000 }, cancellation.signal);
    if (!cancelled.accepted) throw new Error('lifetime cleanup leaked admission');
    const cancellationReader = cancelled.response.body?.getReader();
    if (!cancellationReader) throw new Error('missing cancellation body');
    await cancellationReader.read();
    const pending = cancellationReader.read();
    cancellation.abort();
    await expect(pending).rejects.toThrow();
    expect(cancelled.timedOut()).toBe(false);
    cancellationReader.releaseLock();
    await cancelled.close();

    openingDelay = 1500;
    const refused = await executor.openStream({ ...call, timeoutMs: 30000 }, new AbortController().signal);
    expect(refused).toMatchObject({ accepted: false, outcome: { code: 'timeout' } });
  } finally {
    owner.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 10000);
