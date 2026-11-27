import { z } from 'zod';
import {
  ServiceIdSchema,
  ServiceOperationIdSchema,
  ServiceRequestPayloadSchema,
  ServiceRevisionSchema,
} from '../service/contracts.ts';
import {
  MAX_ARG_COUNT,
  MAX_STDIN_BYTES,
  MAX_STREAM_CHUNK_BYTES,
  MAX_STREAM_TOTAL_BYTES,
  MAX_STREAM_WINDOW_BYTES,
  MAX_STREAM_TIMEOUT_MS,
} from './bounds.ts';
import { FailureSchema, RefusalFields, refusalRefinement } from './failure.ts';
import { addInputBoundIssues, base64PayloadRefinement, BoundedArgSchema } from './payload.ts';
import { NodeIdSchema } from './identity.ts';
export const StreamIdSchema = z.uuid();
export const StreamChannelSchema = z.enum(['stdout', 'stderr', 'data']);
export const StreamTerminalReasonSchema = z.enum([
  'completed',
  'cancelled',
  'timeout',
  'limit',
  'slow-consumer',
  'disconnect',
  'unsupported',
  'error',
]);
export type StreamTerminalReason = z.infer<typeof StreamTerminalReasonSchema>;

/** A stream profile a node declares and a caller names. */
export const StreamProfileNameSchema = z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,63}$/);

export const StreamSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('profile'),
    profile: StreamProfileNameSchema,
    args: z.array(BoundedArgSchema).max(MAX_ARG_COUNT),
    stdin: z.string().max(MAX_STDIN_BYTES).nullable(),
    cursor: z.string().min(1).max(512).nullable(),
  }),
  z.strictObject({
    kind: z.literal('service'),
    service: ServiceIdSchema,
    revision: ServiceRevisionSchema,
    operation: ServiceOperationIdSchema,
    payload: ServiceRequestPayloadSchema,
  }),
]);

export const StreamOpenSchema = z
  .strictObject({
    streamId: StreamIdSchema,
    ts: z.string().max(64),
    from: NodeIdSchema,
    to: NodeIdSchema,
    source: StreamSourceSchema,
    timeoutMs: z.number().int().min(1).max(MAX_STREAM_TIMEOUT_MS),
    requestedWindowBytes: z.number().int().min(1).max(MAX_STREAM_WINDOW_BYTES),
  })
  .superRefine((open, ctx) => {
    if (open.source.kind !== 'profile') return;
    addInputBoundIssues(ctx, {
      name: 'args',
      values: open.source.args,
      stdin: open.source.stdin,
      path: ['source'],
    });
  });
export type StreamOpen = z.infer<typeof StreamOpenSchema>;

export const StreamLimitsSchema = z
  .object({
    maxChunkBytes: z.number().int().min(1).max(MAX_STREAM_CHUNK_BYTES),
    maxWindowBytes: z.number().int().min(1).max(MAX_STREAM_WINDOW_BYTES),
    maxStreamBytes: z.number().int().min(1).max(MAX_STREAM_TOTAL_BYTES),
    slowConsumerTimeoutMs: z.number().int().min(1_000).max(300_000),
  })
  .strict();
export type StreamLimits = z.infer<typeof StreamLimitsSchema>;

export const StreamInvokeSchema = z.object({ open: StreamOpenSchema, limits: StreamLimitsSchema }).strict();
export type StreamInvoke = z.infer<typeof StreamInvokeSchema>;

export const StreamAdmissionSchema = z
  .object({
    accepted: z.boolean(),
    failure: FailureSchema,
    ...RefusalFields,
    detail: z.string().max(4_096),
    limits: StreamLimitsSchema.nullable(),
  })
  .strict()
  .superRefine(refusalRefinement);
export type StreamAdmission = z.infer<typeof StreamAdmissionSchema>;

export const StreamChunkFields = {
  streamId: StreamIdSchema,
  from: NodeIdSchema,
  seq: z.number().int().min(0),
  channel: StreamChannelSchema,
  encoding: z.literal('base64'),
  data: z.string().max(Math.ceil((MAX_STREAM_CHUNK_BYTES * 4) / 3) + 4),
  bytes: z.number().int().min(1).max(MAX_STREAM_CHUNK_BYTES),
  cursor: z.string().min(1).max(512).nullable(),
};
export const StreamChunkSchema = z.object(StreamChunkFields).strict().superRefine(base64PayloadRefinement);
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

export const StreamWindowSchema = z
  .object({
    streamId: StreamIdSchema,
    from: NodeIdSchema,
    creditBytes: z.number().int().min(1).max(MAX_STREAM_WINDOW_BYTES),
  })
  .strict();
export type StreamWindow = z.infer<typeof StreamWindowSchema>;

export const StreamCancelSchema = z
  .object({
    streamId: StreamIdSchema,
    from: NodeIdSchema,
    reason: z.string().min(1).max(512),
  })
  .strict();
export type StreamCancel = z.infer<typeof StreamCancelSchema>;

export const StreamEndFields = {
  streamId: StreamIdSchema,
  from: NodeIdSchema,
  lastSeq: z.number().int().min(-1),
  code: z.number().int(),
  reason: StreamTerminalReasonSchema,
  cursor: z.string().min(1).max(512).nullable(),
};
export const StreamEndSchema = z.object(StreamEndFields).strict();
export type StreamEnd = z.infer<typeof StreamEndSchema>;

export const StreamErrorFields = {
  streamId: StreamIdSchema,
  from: z.union([NodeIdSchema, z.literal('broker')]),
  failure: FailureSchema,
  ...RefusalFields,
  /** How the stream ENDED. Orthogonal to `refusal`, which says why it was refused: a stream can
   *  end at `limit` because the producer was over capacity or because the request itself was too
   *  large, and a consumer routes those two differently. */
  reason: StreamTerminalReasonSchema,
  detail: z.string().max(4_096),
};
export const StreamErrorSchema = z.object(StreamErrorFields).strict().superRefine(refusalRefinement);
export type StreamError = z.infer<typeof StreamErrorSchema>;

export const StreamAckSchema = z.object({ ok: z.boolean(), detail: z.string().max(4_096) }).strict();
export type StreamAck = z.infer<typeof StreamAckSchema>;
