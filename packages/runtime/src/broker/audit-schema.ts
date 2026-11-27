import { z } from 'zod';
import {
  FailureSchema,
  RefusalSchema,
  TransportCauseSchema,
} from '../../../contracts/src/protocol/failure.ts';
import { PublicationTraceSchema } from '../node/publication-trace.ts';
import { LaneVolumeSchema } from '../transport/lane-volume.ts';
import { ServiceTraceSchema } from '../service/trace.ts';
import { StallAuditSchema } from './stall-audit.ts';
import { ServiceAuditSchema, ServiceAuditBatchSchema } from '../service/audit-schema.ts';

const refusalFields = { refusal: RefusalSchema, detail: z.string() };

/** Broker decisions validated at the journal boundary; types derive from this contract. */
const AuditEventSchema = z.discriminatedUnion('kind', [
  LaneVolumeSchema,
  PublicationTraceSchema,
  ServiceTraceSchema,
  ServiceAuditSchema,
  ServiceAuditBatchSchema,
  z.object({ kind: z.literal('connect'), nodeId: z.string(), serves: z.boolean(), version: z.string() }),
  z.object({ kind: z.literal('connect-refused'), nodeId: z.string(), detail: z.string() }),
  z.object({ kind: z.literal('protocol-rejected'), direction: z.string(), event: z.string() }),
  z.object({ kind: z.literal('disconnect'), nodeId: z.string(), broker: z.string(), reason: z.string() }),
  StallAuditSchema,
  z.object({
    kind: z.literal('stream-open'),
    streamId: z.string(),
    from: z.string(),
    to: z.string(),
    source: z.enum(['profile', 'service']),
    subject: z.string(),
    requestBytes: z.number().int().min(0),
    resumeRequested: z.boolean(),
    accepted: z.boolean(),
    transportCause: TransportCauseSchema.nullable(),
    ...refusalFields,
  }),
  z.object({
    kind: z.literal('stream-terminal'),
    streamId: z.string(),
    from: z.string(),
    reason: z.string(),
  }),
  z.object({
    kind: z.literal('event-subscription'),
    subscriptionId: z.string(),
    topic: z.string(),
    subscriber: z.string(),
    resumeFrom: z.number().int().min(0).nullable(),
    accepted: z.boolean(),
    transportCause: TransportCauseSchema.nullable(),
    ...refusalFields,
  }),
  z.object({
    kind: z.literal('event-publish'),
    topic: z.string(),
    producer: z.string(),
    bootId: z.string(),
    seq: z.number().int().min(0),
    bytes: z.number().int().min(0),
    cursorPresent: z.boolean(),
    accepted: z.boolean(),
    transportCause: TransportCauseSchema.nullable(),
    ...refusalFields,
  }),
  z.object({
    kind: z.literal('event-declare'),
    producer: z.string(),
    accepted: z.number().int().min(0),
    refused: z.number().int().min(0),
    detail: z.string(),
  }),
  z.object({
    kind: z.literal('service-declare'),
    target: z.string(),
    accepted: z.number().int().min(0),
    refused: z.number().int().min(0),
    detail: z.string(),
  }),
  z.object({
    kind: z.literal('fleet-bundle'),
    from: z.string(),
    serial: z.number().int().min(1).nullable(),
    signer: z.string().nullable(),
    accepted: z.boolean(),
    detail: z.string(),
  }),
  z.object({
    kind: z.literal('call'),
    id: z.string(),
    from: z.string(),
    to: z.string(),
    command: z.string(),
    argc: z.number().int().min(0),
    argvBytes: z.number().int().min(0),
    stdinBytes: z.number().int().min(0),
    accepted: z.boolean(),
    failure: FailureSchema,
    transportCause: TransportCauseSchema.nullable(),
    ...refusalFields,
  }),
  z.object({
    kind: z.literal('result'),
    id: z.string(),
    from: z.string(),
    to: z.string(),
    code: z.number().int(),
    failure: FailureSchema,
    refusal: RefusalSchema,
    transportCause: TransportCauseSchema.nullable(),
    ms: z.number().min(0),
  }),
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/** Each record is dated by the writer; service ordinals order facts within one journal epoch. */
export const AuditRecordSchema = AuditEventSchema.and(z.object({ ts: z.iso.datetime() })).superRefine(
  (record, ctx) => {
    if (record.kind === 'service' && record.ordinal === undefined)
      ctx.addIssue({ code: 'custom', path: ['ordinal'], message: 'service record requires writer order' });
  },
);
