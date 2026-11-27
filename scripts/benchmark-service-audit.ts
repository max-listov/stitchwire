import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { readDiagnosticJournal } from 'stitchkit/application/diagnostic-journal';
import { createAudit } from '../packages/runtime/src/broker/audit.ts';
import { AuditRecordSchema, type AuditEvent } from '../packages/runtime/src/broker/audit-schema.ts';
import { median } from './bench-stats.ts';

const calls = z.coerce
  .number()
  .int()
  .min(32)
  .max(1500)
  .parse(Bun.argv[2] ?? 1000);
/**
 * `service-only` measures the batcher in isolation. `mixed` interleaves the other records a live
 * broker writes between service facts, in the proportions of a measured day on a busy broker
 * (per service call: about 1.7 event publications, 0.4 subscription decisions, 0.2 call/result
 * pairs). A batcher that only pays off on the first workload does not pay off in production.
 */
const mix = z.enum(['service-only', 'mixed']).parse(Bun.argv[3] ?? 'mixed');
let publication = 0;
const interleaved = (n: number): AuditEvent[] => {
  if (mix === 'service-only') return [];
  const others: AuditEvent[] = [];
  for (let k = 0; k < (n % 10 < 7 ? 2 : 1); k++)
    others.push({
      kind: 'event-publish',
      topic: 'example.status',
      producer: 'owner',
      bootId: '00000000-0000-4000-8000-000000000001',
      seq: ++publication,
      bytes: 420,
      cursorPresent: false,
      accepted: true,
      transportCause: null,
      refusal: 'none',
      detail: '',
    });
  if (n % 5 < 2)
    others.push({
      kind: 'event-subscription',
      subscriptionId: `sub${n}`,
      topic: 'example.status',
      subscriber: 'reader',
      resumeFrom: null,
      accepted: true,
      transportCause: null,
      refusal: 'none',
      detail: '',
    });
  return others;
};
const root = await mkdtemp(join(tmpdir(), 'wire-service-audit-bench-'));
const input: AuditEvent[] = [];
let serviceFacts = 0;
for (let n = 0; n < calls; n++) {
  const common: Pick<
    Extract<AuditEvent, { kind: 'service' }>,
    'kind' | 'id' | 'traceId' | 'from' | 'to' | 'service' | 'operation' | 'requestBytes' | 'transportCause'
  > = {
    kind: 'service',
    id: `call${n}`,
    traceId: crypto.randomUUID(),
    from: 'reader',
    to: 'owner',
    service: 'example.metrics',
    operation: 'read',
    requestBytes: 2,
    transportCause: null,
  };
  input.push(
    { ...common, phase: 'dispatch', outcome: 'admitted', ms: 0.02, responseBytes: null, delivery: null },
    ...interleaved(n),
    { ...common, phase: 'result', outcome: 'received', ms: 2.5, responseBytes: 2400, delivery: 'delivered' },
  );
  serviceFacts += 2;
}
try {
  const samples = [];
  for (let round = 0; round < 8; round++) {
    const path = join(root, `audit${round}.jsonl`);
    const audit = await createAudit(path, 4096, { maxBytes: 64 * 1024 * 1024, keep: 1 });
    try {
      const before = process.cpuUsage(),
        started = performance.now();
      for (const event of input) audit.write(event);
      await audit.flush();
      const elapsed = performance.now() - started,
        cpu = process.cpuUsage(before);
      const status = audit.status();
      await audit.close();
      if (status.dropped !== 0 || status.writeFailures !== 0 || status.queued !== 0)
        throw new Error('journal lost records');
      let records = 0,
        frames = 0,
        batches = 0,
        batchedRows = 0;
      for await (const row of readDiagnosticJournal({
        paths: [path],
        eventSchema: AuditRecordSchema,
        maxLineBytes: 256 * 1024,
      })) {
        if (row.type === 'anomaly')
          throw new Error(`benchmark journal ${row.anomaly.reason} at ${row.anomaly.offset}`);
        frames++;
        if (row.frame.event.kind === 'service-batch') {
          batches++;
          batchedRows += row.frame.event.rows.length;
          records += row.frame.event.rows.length;
        } else records++;
      }
      if (records !== input.length) throw new Error('logical record count changed');
      if (round > 0)
        samples.push({
          cpuUsPerCall: (cpu.user + cpu.system) / calls,
          wallUsPerCall: (elapsed * 1000) / calls,
          bytes: (await stat(path)).size,
          frames,
          records,
          rowsPerBatch: batches === 0 ? 0 : batchedRows / batches,
        });
    } finally {
      await audit.close();
    }
  }
  console.log(
    JSON.stringify({
      bun: Bun.version,
      platform: process.platform,
      arch: process.arch,
      cpu: cpus()[0]?.model,
      calls,
      mix,
      serviceFacts,
      warmupRounds: 1,
      samples,
      medianCpuUsPerCall: median(samples.map((sample) => sample.cpuUsPerCall)),
      medianWallUsPerCall: median(samples.map((sample) => sample.wallUsPerCall)),
      medianBytes: median(samples.map((sample) => sample.bytes)),
      bytesPerServiceFact: median(samples.map((sample) => sample.bytes)) / serviceFacts,
      rowsPerBatch: median(samples.map((sample) => sample.rowsPerBatch)),
      qualification:
        'Saturated journal-only workload, identical call facts; not RPC latency or a live idle CPU claim.',
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
