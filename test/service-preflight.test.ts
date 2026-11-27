import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import {
  ServiceDescriptorSchema,
  ServicePolicySchema,
} from '../packages/contracts/src/service/policy-schema.ts';
import {
  type DescriptorLoad,
  ServiceDescriptorStore,
} from '../packages/runtime/src/service/descriptor-store.ts';
import { ServiceExecutor } from '../packages/runtime/src/service/executor.ts';
import { bindUnixSocket } from 'stitchkit/files';

class HeldDescriptor extends ServiceDescriptorStore {
  readonly entered = Promise.withResolvers<void>();
  readonly result = Promise.withResolvers<DescriptorLoad>();
  override load(): Promise<DescriptorLoad> {
    this.entered.resolve();
    return this.result.promise;
  }
}

async function fixture(
  kind: 'unary' | 'stream' = 'unary',
  operationTimeoutMs = 5000,
  ownerFetch?: () => Response | Promise<Response>,
) {
  const root = await mkdtemp('/tmp/wire-preflight-');
  const socketPath = `${root}/owner.sock`;
  let dispatches = 0;
  const owner = bindUnixSocket({ path: socketPath, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      fetch: () => {
        dispatches++;
        return ownerFetch ? ownerFetch() : Response.json({ ok: true });
      },
    }),
  );
  const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 };
  const descriptor = ServiceDescriptorSchema.parse({
    service: 'example.write',
    revision: '1',
    maxInflight: 1,
    operations: [
      {
        id: 'write',
        path: '/write',
        effect: 'write',
        limits: { ...limits, timeoutMs: operationTimeoutMs },
        response: kind === 'unary' ? { kind: 'unary' } : { kind: 'stream', lifetimeMs: 30000 },
      },
    ],
  });
  const policy = ServicePolicySchema.parse({
    bindings: [
      {
        service: descriptor.service,
        socketPath,
        descriptorPath: `${root}/descriptor.json`,
        endpointPath: '/invoke',
        maxInflight: 1,
        limits,
      },
    ],
    grants: [
      {
        caller: 'self',
        target: 'self',
        service: descriptor.service,
        scope: { kind: 'operation', operation: 'write' },
      },
    ],
  });
  const store = new HeldDescriptor();
  const executor = new ServiceExecutor(policy, 'self', store);
  const call = {
    id: crypto.randomUUID(),
    from: 'self',
    to: 'self',
    service: descriptor.service,
    revision: '1',
    operation: 'write',
    payload: '{}',
    timeoutMs: 5000,
  };
  return {
    executor,
    policy,
    store,
    call,
    dispatches: () => dispatches,
    release: () => store.result.resolve({ state: 'loaded', descriptor }),
    close: async () => {
      owner.stop(true);
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('executor shutdown drains self-target unary preflight and forbids late owner dispatch', async () => {
  const f = await fixture();
  try {
    const pending = f.executor.execute(f.call, new AbortController().signal);
    await f.store.entered.promise;
    await f.executor.drain();
    expect(await pending).toMatchObject({ cancellationOrigin: 'agent-shutdown', delivery: 'not-dispatched' });
    f.release();
    expect(await f.executor.execute(f.call, new AbortController().signal)).toMatchObject({
      cancellationOrigin: 'agent-shutdown',
    });
    expect(f.dispatches()).toBe(0);
  } finally {
    await f.close();
  }
});

test('executor shutdown drains owner body and retains terminal evidence', async () => {
  const entered = Promise.withResolvers<void>();
  const f = await fixture('unary', 5000, () => {
    entered.resolve();
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{'));
        },
      }),
    );
  });
  try {
    f.release();
    const pending = f.executor.execute(f.call, new AbortController().signal);
    await entered.promise;
    await f.executor.drain();
    const result = await pending;
    expect(result).toMatchObject({ cancellationOrigin: 'agent-shutdown', delivery: 'unknown' });
    expect(result.diagnostics?.phases.at(-1)?.phase).toBe('terminal');
  } finally {
    await f.close();
  }
});

test('stream cancellation interrupts descriptor preflight without touching the owner', async () => {
  const f = await fixture('stream');
  try {
    const cancellation = new AbortController();
    const pending = f.executor.openStream(f.call, cancellation.signal);
    await f.store.entered.promise;
    cancellation.abort();
    expect(await pending).toMatchObject({
      accepted: false,
      outcome: { code: 'cancelled', delivery: 'not-dispatched' },
    });
    f.release();
    expect(f.dispatches()).toBe(0);
  } finally {
    f.release();
    await f.close();
  }
});

test('stream operation opening limit includes time spent discovering the descriptor', async () => {
  const f = await fixture('stream', 10);
  try {
    const pending = f.executor.openStream(f.call, new AbortController().signal);
    await f.store.entered.promise;
    await Bun.sleep(30);
    f.release();
    expect(await pending).toMatchObject({
      accepted: false,
      outcome: { code: 'timeout', delivery: 'not-dispatched' },
    });
    expect(f.dispatches()).toBe(0);
  } finally {
    f.release();
    await f.close();
  }
});

test('cancellation after dispatch preserves unknown delivery and releases admission', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<Response>();
  let first = true;
  const f = await fixture('unary', 5000, () => {
    if (!first) return Response.json({ ok: true });
    first = false;
    entered.resolve();
    return release.promise;
  });
  try {
    f.release();
    const cancellation = new AbortController();
    const pending = f.executor.execute(f.call, cancellation.signal);
    await entered.promise;
    cancellation.abort();
    const cancelled = await pending;
    expect(cancelled).toMatchObject({
      code: 'cancelled',
      delivery: 'unknown',
      cancellationOrigin: 'caller-abort',
    });
    const phases = cancelled.diagnostics?.phases.map((entry) => entry.phase);
    expect(phases).toContain('http-start');
    expect(phases).not.toContain('http-headers');
    expect(phases?.at(-1)).toBe('terminal');
    release.resolve(Response.json({ ok: true }));
    expect(await f.executor.execute(f.call, new AbortController().signal)).toMatchObject({
      status: 'response',
    });
    expect(f.dispatches()).toBe(2);
  } finally {
    release.resolve(Response.json({ ok: true }));
    f.release();
    await f.close();
  }
});

test('abort during descriptor load never dispatches an owner write after load completes', async () => {
  const f = await fixture();
  try {
    const cancellation = new AbortController();
    const pending = f.executor.execute(f.call, cancellation.signal);
    await f.store.entered.promise;
    cancellation.abort();
    f.release();
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ code: 'cancelled', delivery: 'not-dispatched' });
    expect(cancelled.diagnostics?.phases.map((entry) => entry.phase)).not.toContain('http-start');
    expect(f.dispatches()).toBe(0);
    expect(await f.executor.execute(f.call, new AbortController().signal)).toMatchObject({
      status: 'response',
    });
    expect(f.dispatches()).toBe(1);
  } finally {
    f.release();
    await f.close();
  }
});

test('slow owner body records an unfinished read and executor deadline without safe retry', async () => {
  const f = await fixture(
    'unary',
    5000,
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  try {
    f.release();
    const result = await f.executor.execute({ ...f.call, timeoutMs: 50 }, new AbortController().signal);
    expect(result).toMatchObject({
      code: 'timeout',
      delivery: 'unknown',
      cancellationOrigin: 'executor-deadline',
    });
    const phases = result.diagnostics?.phases.map((entry) => entry.phase);
    expect(phases).toContain('http-headers');
    expect(phases).toContain('body-start');
    expect(phases).not.toContain('body-end');
    expect(phases?.at(-1)).toBe('terminal');
  } finally {
    await f.close();
  }
});

for (const reason of ['cancelled', 'timeout']) {
  test(`${reason} settles before a blocked descriptor is released`, async () => {
    const f = await fixture();
    try {
      const cancellation = new AbortController();
      const pending = f.executor.execute(
        { ...f.call, timeoutMs: reason === 'timeout' ? 20 : 5000 },
        cancellation.signal,
      );
      await f.store.entered.promise;
      if (reason === 'cancelled') cancellation.abort();
      // The guard only prevents a broken implementation hanging the suite. The descriptor
      // remains unresolved until after the assertion, so it cannot explain settlement.
      const guard = AbortSignal.timeout(1000);
      const result = await Promise.race([
        pending,
        new Promise((resolve) =>
          guard.addEventListener('abort', () => resolve('still waiting'), { once: true }),
        ),
      ]);
      expect(result).toMatchObject({ code: reason, delivery: 'not-dispatched' });
      f.release();
      await pending;
      expect(await f.executor.execute(f.call, new AbortController().signal)).toMatchObject({
        status: 'response',
      });
      expect(f.dispatches()).toBe(1);
    } finally {
      f.release();
      await f.close();
    }
  });
}

test('a policy replacement during descriptor I/O cannot dispatch its new binding with an old descriptor', async () => {
  const f = await fixture();
  try {
    const pending = f.executor.execute(f.call, new AbortController().signal);
    await f.store.entered.promise;
    f.executor.usePolicy({
      ...f.policy,
      bindings: f.policy.bindings.map((binding) => ({
        ...binding,
        descriptorPath: '/tmp/other-owner-descriptor.json',
        endpointPath: '/new-owner',
      })),
    });
    f.release();
    expect(await pending).toMatchObject({ code: 'unavailable', delivery: 'not-dispatched' });
    expect(f.dispatches()).toBe(0);
    f.executor.usePolicy(f.policy);
    expect(await f.executor.execute(f.call, new AbortController().signal)).toMatchObject({
      status: 'response',
    });
    expect(f.dispatches()).toBe(1);
  } finally {
    f.release();
    await f.close();
  }
});

test('an equivalent policy refresh during descriptor I/O preserves the first admitted call', async () => {
  const f = await fixture();
  try {
    const pending = f.executor.execute(f.call, new AbortController().signal);
    await f.store.entered.promise;
    f.executor.usePolicy({
      grants: f.policy.grants.map((grant) => ({ ...grant })),
      bindings: f.policy.bindings.map((binding) => ({ ...binding })),
    });
    f.release();
    expect(await pending).toMatchObject({ status: 'response' });
    expect(f.dispatches()).toBe(1);
  } finally {
    f.release();
    await f.close();
  }
});
