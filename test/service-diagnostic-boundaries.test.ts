import { expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { z } from 'zod';
import { createAudit } from '../packages/runtime/src/broker/audit.ts';
import { serviceTrace, ServiceTraceSchema } from '../packages/runtime/src/service/trace.ts';
import { createLocalServiceRoute } from '../packages/runtime/src/service/local.ts';
import { ServiceDiagnosticsSchema } from '../packages/contracts/src/service/diagnostics.ts';

test('service journal drops visibly, rotates boundedly and excludes payload across all generations', async () => {
  const root = await mkdtemp('/tmp/wire-trace-bounds-');
  const audit = await createAudit(`${root}/trace.jsonl`, 2, { maxBytes: 2048, keep: 2 });
  const trace = serviceTrace(audit, 'reader');
  const input = {
    traceId: crypto.randomUUID(),
    to: 'worker',
    service: 'example.read',
    operation: 'read',
    payload: 'SECRET-SENTINEL',
  };
  try {
    trace({ traceId: input.traceId }, 'door-entry', 0);
    await audit.flush();
    expect(audit.status().dropped).toBe(0);
    for (let i = 0; i < 100; i++) trace(input, 'door-parsed', i);
    await audit.flush();
    expect(audit.status().dropped).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) {
      trace(input, 'door-result', i);
      await audit.flush();
    }
    const files = (await readdir(root)).filter((name) => /^trace\.jsonl(?:\.\d+)?$/.test(name));
    expect(files).toHaveLength(3);
    for (const file of files) {
      expect((await stat(`${root}/${file}`)).size).toBeLessThanOrEqual(2048);
      const text = await readFile(`${root}/${file}`, 'utf8');
      expect(text).not.toContain('SECRET-SENTINEL');
      for (const line of text.trim().split('\n')) {
        const row = z
          .object({ event: ServiceTraceSchema.extend({ ts: z.iso.datetime() }) })
          .parse(JSON.parse(line));
        expect(row.event.traceId).toBe(input.traceId);
      }
    }
    const diagnostics = {
      traceId: input.traceId,
      requestId: crypto.randomUUID(),
      phases: Array.from({ length: 17 }, () => ({ phase: 'terminal', elapsedMs: 1 })),
    };
    expect(ServiceDiagnosticsSchema.safeParse(diagnostics).success).toBe(false);
    expect(
      ServiceTraceSchema.safeParse({
        kind: 'service-phase',
        node: 'reader',
        traceId: input.traceId,
        phase: 'door-entry',
        elapsedMs: 0,
        payload: 'SECRET-SENTINEL',
      }).success,
    ).toBe(false);
  } finally {
    await audit.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('raw door records body wait, departure and capacity before typed dispatch', async () => {
  const rows: { phase: string; traceId?: string; elapsed: number; code?: string; origin?: string }[] = [];
  let dispatches = 0;
  const route = createLocalServiceRoute(
    {
      invokeService: async () => {
        dispatches++;
        throw new Error('unexpected dispatch');
      },
    },
    (call, phase, elapsed, outcome) =>
      rows.push({
        phase,
        traceId: call.traceId,
        elapsed,
        ...(outcome?.status === 'failure' ? { code: outcome.code, origin: outcome.cancellationOrigin } : {}),
      }),
  );
  const controllers: AbortController[] = [];
  const pending: Promise<Response>[] = [];
  for (let i = 0; i < 32; i++) {
    const controller = new AbortController();
    controllers.push(controller);
    const request = new Request(`http://wire.invalid${route.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-stitchwire-trace-id': crypto.randomUUID() },
      signal: controller.signal,
      body: new ReadableStream(),
    });
    pending.push(Promise.resolve(route.handler(request, { params: {} })));
  }
  try {
    expect(rows.filter((row) => row.phase === 'door-entry')).toHaveLength(32);
    const refused = await route.handler(
      new Request(`http://wire.invalid${route.path}`, { method: 'POST', body: '{}' }),
      { params: {} },
    );
    expect(await refused.json()).toMatchObject({ outcome: { code: 'capacity' } });
    expect(rows.at(-1)).toMatchObject({ phase: 'door-terminal', code: 'capacity' });
    await Bun.sleep(10);
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
    const departed = rows.filter((row) => row.origin === 'door-disconnect');
    expect(departed).toHaveLength(32);
    expect(departed.every((row) => row.elapsed >= 10)).toBe(true);
    expect(dispatches).toBe(0);
  } finally {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(pending);
  }
});
