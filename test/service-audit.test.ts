import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticJournalFrameSchema } from 'stitchkit/application';
import {
  ServiceFailureCodeSchema,
  ServiceFailureOutcomeSchema,
} from '../packages/contracts/src/service/contracts.ts';
import { MAX_RETRY_AFTER_MS } from '../packages/contracts/src/protocol/failure.ts';
import { IntegerCallerOptionSchema } from '../packages/runtime/src/config/profiles.ts';
import { createAudit } from '../packages/runtime/src/broker/audit.ts';
import { AuditRecordSchema } from '../packages/runtime/src/broker/audit-schema.ts';
import { ServiceAuditBatcher, serviceAuditRecords } from '../packages/runtime/src/broker/service-audit.ts';
import {
  ServiceAuditBatchSchema,
  ServiceAuditRecordSchema,
  type ServiceAuditBatch,
  type ServiceAuditRecord,
} from '../packages/runtime/src/service/audit-schema.ts';

function record(n: number, fields: Partial<ServiceAuditRecord> = {}): ServiceAuditRecord {
  return {
    kind: 'service',
    ordinal: n + 1,
    id: `call${n}`,
    traceId: crypto.randomUUID(),
    from: 'reader',
    to: 'owner',
    service: 'example.metrics',
    operation: 'read',
    phase: 'result',
    outcome: 'received',
    ms: n / 10,
    requestBytes: n + 2,
    responseBytes: n + 50,
    delivery: 'delivered',
    transportCause: null,
    ts: new Date(1700000000000 + n).toISOString(),
    ...fields,
  };
}
const expand = (output: (ServiceAuditRecord | ServiceAuditBatch)[]) =>
  output.flatMap((item) => (item.kind === 'service-batch' ? serviceAuditRecords(item) : [item]));

test('audit admits canonical outcomes and delivery classes, not arbitrary strings', () => {
  for (const outcome of [...ServiceFailureCodeSchema.options, 'admitted', 'received'])
    expect(ServiceAuditRecordSchema.safeParse({ ...record(0), outcome }).success).toBe(true);
  for (const delivery of [...ServiceFailureOutcomeSchema.shape.delivery.options, 'delivered', null])
    expect(ServiceAuditRecordSchema.safeParse({ ...record(0), delivery }).success).toBe(true);
  for (const field of ['outcome', 'delivery']) {
    const invalid = { ...record(0), [field]: 'invented-state' };
    expect(ServiceAuditRecordSchema.safeParse(invalid).success).toBe(false);
    expect(AuditRecordSchema.safeParse(invalid).success).toBe(false);
  }
});

test('a service refusal shares the transport retry ceiling; caller integers keep safe-integer bounds', () => {
  // One retry hint for every plane: a peer cannot park a client for a day by writing one number.
  const failure = {
    status: 'failure',
    code: 'capacity',
    delivery: 'not-dispatched',
    refusal: 'capacity',
    retryAfterMs: MAX_RETRY_AFTER_MS,
    transportCause: null,
  };
  expect(ServiceFailureOutcomeSchema.safeParse(failure).success).toBe(true);
  for (const invalid of [MAX_RETRY_AFTER_MS + 1, Infinity, 0.5, -1])
    expect(ServiceFailureOutcomeSchema.safeParse({ ...failure, retryAfterMs: invalid }).success).toBe(false);
  const option = { type: 'integer', min: 0, max: Number.MAX_SAFE_INTEGER };
  expect(IntegerCallerOptionSchema.safeParse(option).success).toBe(true);
  for (const invalid of [Number.MAX_SAFE_INTEGER + 1, Infinity, 0.5, -1]) {
    expect(IntegerCallerOptionSchema.safeParse({ ...option, max: invalid }).success).toBe(false);
    expect(IntegerCallerOptionSchema.safeParse({ ...option, min: invalid }).success).toBe(false);
  }
});

test('compaction preserves exact per-request facts, including successful side effects and phase order', () => {
  const output: (ServiceAuditRecord | ServiceAuditBatch)[] = [];
  const batcher = new ServiceAuditBatcher((item) => output.push(item));
  const records = Array.from({ length: 128 }, (_, n) =>
    record(n, {
      operation: 'write',
      phase: n % 2 === 0 ? 'dispatch' : 'result',
      outcome: n % 2 === 0 ? 'admitted' : 'received',
      delivery: n % 2 === 0 ? null : 'delivered',
    }),
  );
  for (const item of records) batcher.record(item);
  batcher.flush();
  expect(output).toHaveLength(2);
  for (const item of output) expect(ServiceAuditBatchSchema.safeParse(item).success).toBe(true);
  expect(expand(output)).toEqual(records);
  expect(batcher.pendingRows).toBe(0);
});

test('failures and cancellations flush previous successes and remain individual; route identities never collide', () => {
  const output: (ServiceAuditRecord | ServiceAuditBatch)[] = [];
  const batcher = new ServiceAuditBatcher((item) => output.push(item));
  const records = [
    record(1),
    record(2),
    record(3, { outcome: 'denied', delivery: 'not-dispatched' }),
    record(4, { cancellationOrigin: 'caller-disconnect', outcome: 'cancelled' }),
    record(5, { from: 'other' }),
    record(6, { operation: 'other' }),
  ];
  for (const item of records) batcher.record(item);
  batcher.flush();
  expect(expand(output)).toEqual(records);
  expect(output.slice(1).every((item) => item.kind === 'service')).toBe(true);
});

test('high cardinality and large rows cannot create an unbounded buffer or lose facts', () => {
  const output: (ServiceAuditRecord | ServiceAuditBatch)[] = [];
  const batcher = new ServiceAuditBatcher((item) => output.push(item));
  const records = Array.from({ length: 1200 }, (_, n) => record(n, { operation: `operation${n}` }));
  for (const item of records) {
    batcher.record(item);
    expect(batcher.pendingRows).toBeLessThanOrEqual(128);
  }
  batcher.flush();
  expect(expand(output)).toEqual(records);
  const large = record(0, { id: 'x'.repeat(1024 * 1024 + 1) });
  batcher.record(large);
  expect(batcher.pendingRows).toBe(0);
  expect(output.at(-1)).toEqual(large);
});

test('batch schema rejects empty, oversized and malformed logical rows', () => {
  const output: (ServiceAuditRecord | ServiceAuditBatch)[] = [];
  const batcher = new ServiceAuditBatcher((item) => output.push(item));
  batcher.record(record(1));
  batcher.record(record(2));
  batcher.flush();
  const batch = ServiceAuditBatchSchema.parse(output[0]);
  expect(ServiceAuditBatchSchema.safeParse({ ...batch, rows: [] }).success).toBe(false);
  expect(ServiceAuditBatchSchema.safeParse({ ...batch, rows: Array(65).fill(batch.rows[0]) }).success).toBe(
    false,
  );
  expect(ServiceAuditBatchSchema.safeParse({ ...batch, rows: [{ ...batch.rows[0], ms: -1 }] }).success).toBe(
    false,
  );
});

test('unsafe ordinals and unknown call pointers are rejected', () => {
  const output: (ServiceAuditRecord | ServiceAuditBatch)[] = [];
  const batcher = new ServiceAuditBatcher((item) => output.push(item));
  batcher.record(record(1));
  batcher.record(record(2));
  batcher.flush();
  const batch = ServiceAuditBatchSchema.parse(output[0]);
  expect(
    ServiceAuditBatchSchema.safeParse({ ...batch, rows: [{ ...batch.rows[0], call: batch.calls.length }] })
      .success,
  ).toBe(false);
  expect(
    ServiceAuditRecordSchema.safeParse({ ...record(1), ordinal: Number.MAX_SAFE_INTEGER + 1 }).success,
  ).toBe(false);
});

test('tight rotation ceilings split a compact batch instead of refusing its valid individual facts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-service-small-journal-'));
  const path = join(root, 'audit.jsonl');
  const audit = await createAudit(path, 4096, { maxBytes: 1024, keep: 16 });
  try {
    for (let n = 0; n < 12; n++) audit.write(record(n));
    await audit.close();
    expect(audit.status().dropped).toBe(0);
    expect(audit.status().writeFailures).toBe(0);
  } finally {
    await audit.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('actual writer drains lossless service facts on close and refuses post-close calls synchronously', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-service-audit-'));
  const path = join(root, 'audit.jsonl');
  const audit = await createAudit(path);
  const input = [record(1), record(2)];
  try {
    for (const item of input) audit.write(item);
    expect(audit.status().queued).toBe(2);
    await audit.close();
    const rows = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => AuditRecordSchema.parse(DiagnosticJournalFrameSchema.parse(JSON.parse(line)).event));
    expect(rows).toHaveLength(1);
    const decoded = ServiceAuditBatchSchema.parse(rows[0]);
    expect(serviceAuditRecords(decoded).map(({ ts: _ts, ordinal: _ordinal, ...item }) => item)).toEqual(
      input.map(({ ts: _ts, ordinal: _ordinal, ...item }) => item),
    );
    expect(
      serviceAuditRecords(decoded).every((item) => ServiceAuditRecordSchema.safeParse(item).success),
    ).toBe(true);
    audit.write(record(3));
    expect(audit.status().queued).toBe(0);
    expect(audit.status().dropped).toBe(1);
  } finally {
    await audit.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('records of other kinds between service facts do not break their batch', async () => {
  // A live broker writes event publications between almost every pair of service facts. A batch
  // that each of them flushed held about two rows; the batch must survive them, and the order of
  // service facts is carried by their ordinals and timestamps, not by journal position.
  const root = await mkdtemp(join(tmpdir(), 'wire-service-mixed-'));
  const path = join(root, 'audit.jsonl');
  const audit = await createAudit(path);
  try {
    for (let n = 0; n < 10; n++) {
      audit.write(record(n));
      audit.write({
        kind: 'event-publish',
        topic: 'example.status',
        producer: 'owner',
        bootId: '00000000-0000-4000-8000-000000000001',
        seq: n,
        bytes: 420,
        cursorPresent: false,
        accepted: true,
        transportCause: null,
        refusal: 'none',
        detail: '',
      });
    }
    await audit.close();
    const rows = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => AuditRecordSchema.parse(DiagnosticJournalFrameSchema.parse(JSON.parse(line)).event));
    const batches = rows.filter((row) => row.kind === 'service-batch');
    expect(batches).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'event-publish')).toHaveLength(10);
    const facts = serviceAuditRecords(ServiceAuditBatchSchema.parse(batches[0]));
    expect(facts.map((fact) => fact.id)).toEqual(Array.from({ length: 10 }, (_, n) => `call${n}`));
    expect(facts.map((fact) => fact.ordinal)).toEqual(
      [...facts.map((fact) => fact.ordinal)].sort((a, b) => (a ?? 0) - (b ?? 0)),
    );
  } finally {
    await audit.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('quiet successful records flush without requiring another event', async () => {
  const output: (ServiceAuditRecord | ServiceAuditBatch)[] = [];
  const ready = Promise.withResolvers<void>();
  const batcher = new ServiceAuditBatcher((item) => {
    output.push(item);
    ready.resolve();
  });
  batcher.record(record(1));
  batcher.record(record(2));
  // A batch that never flushed would hang here, and the suite's hang bound reports it (ADR 0012).
  await ready.promise;
  expect(expand(output)).toHaveLength(2);
  expect(batcher.pendingRows).toBe(0);
});

test('active NUL tail is isolated without rewriting its evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-torn-audit-'));
  const path = join(root, 'audit.jsonl');
  const damaged = Buffer.concat([Buffer.from('{"incomplete":'), Buffer.alloc(839)]);
  await writeFile(path, damaged);
  const audit = await createAudit(path);
  try {
    audit.write({ kind: 'connect', nodeId: 'owner', serves: true, version: '0.0.0' });
    await audit.flush();
    expect(await readFile(`${path}.1`)).toEqual(damaged);
    expect(() => JSON.parse(damaged.toString())).toThrow();
    const current = DiagnosticJournalFrameSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    expect(AuditRecordSchema.parse(current.event).kind).toBe('connect');
    expect(audit.status().writeFailures).toBe(0);
  } finally {
    await audit.close();
    await rm(root, { recursive: true, force: true });
  }
});
