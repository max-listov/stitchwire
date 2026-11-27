import { z } from 'zod';
import { TransportCauseSchema } from '../../../contracts/src/protocol/failure.ts';
import { ServiceCancellationOriginSchema } from '../../../contracts/src/service/diagnostics.ts';
import {
  ServiceFailureCodeSchema,
  ServiceFailureOutcomeSchema,
} from '../../../contracts/src/service/contracts.ts';

export const ServiceAuditSchema = z.object({
  kind: z.literal('service'),
  /** Writer-owned ordering within this journal epoch, independent of physical batch order. */
  ordinal: z.number().int().positive().optional(),
  traceId: z.uuid().optional(),
  cancellationOrigin: ServiceCancellationOriginSchema.optional(),
  id: z.string(),
  from: z.string(),
  to: z.string(),
  service: z.string(),
  operation: z.string(),
  phase: z.enum(['dispatch', 'result']),
  outcome: ServiceFailureCodeSchema.or(z.enum(['admitted', 'received'])),
  ms: z.number().min(0),
  requestBytes: z.number().int().min(0),
  responseBytes: z.number().int().min(0).nullable(),
  delivery: ServiceFailureOutcomeSchema.shape.delivery.or(z.literal('delivered')).nullable(),
  transportCause: TransportCauseSchema.nullable(),
});
export type ServiceAudit = z.infer<typeof ServiceAuditSchema>;
export const ServiceAuditRecordSchema = ServiceAuditSchema.extend({
  ts: z.iso.datetime(),
  ordinal: z.number().int().positive(),
});
export type ServiceAuditRecord = z.infer<typeof ServiceAuditRecordSchema>;
const shared: Record<'from' | 'to' | 'service' | 'operation', true> = {
  from: true,
  to: true,
  service: true,
  operation: true,
};
const callSchema = ServiceAuditRecordSchema.pick({ id: true, traceId: true, requestBytes: true });
const rowSchema = ServiceAuditRecordSchema.omit({
  kind: true,
  id: true,
  traceId: true,
  requestBytes: true,
  ...shared,
}).extend({ call: z.number().int().nonnegative() });
export const MAX_SERVICE_AUDIT_ROWS = 64;
export const SERVICE_AUDIT_FLUSH_MS = 1000;
export const ServiceAuditBatchSchema = ServiceAuditSchema.pick(shared)
  .extend({
    kind: z.literal('service-batch'),
    calls: z.array(callSchema).min(1).max(MAX_SERVICE_AUDIT_ROWS),
    rows: z.array(rowSchema).min(1).max(MAX_SERVICE_AUDIT_ROWS),
  })
  .superRefine((batch, ctx) => {
    for (const [index, row] of batch.rows.entries())
      if (row.call >= batch.calls.length)
        ctx.addIssue({ code: 'custom', path: ['rows', index, 'call'], message: 'unknown call identity' });
    if (new Set(batch.rows.map((row) => row.call)).size !== batch.calls.length)
      ctx.addIssue({ code: 'custom', path: ['calls'], message: 'unused call identity' });
  });
export type ServiceAuditBatch = z.infer<typeof ServiceAuditBatchSchema>;

const ServiceAuditFactsSchema = ServiceAuditSchema.pick({
  ms: true,
  requestBytes: true,
  responseBytes: true,
  delivery: true,
  transportCause: true,
  cancellationOrigin: true,
});
export type ServiceAuditFacts = z.infer<typeof ServiceAuditFactsSchema>;
