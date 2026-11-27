import { z } from 'zod';
import {
  MAX_ARG_BYTES,
  MAX_ARG_COUNT,
  MAX_COMMAND_TIMEOUT_MS,
  MAX_EVENT_BYTES,
  MAX_STDIN_BYTES,
  MAX_STREAM_TIMEOUT_MS,
} from '../protocol/bounds.ts';
import { TopicNameSchema } from '../protocol/event.ts';
import { NodeIdSchema } from '../protocol/identity.ts';
import { addInputBoundIssues } from '../protocol/payload.ts';
import { StreamProfileNameSchema } from '../protocol/stream.ts';
import {
  ServiceIdSchema,
  ServiceOperationIdSchema,
  ServiceRequestPayloadSchema,
  ServiceRevisionSchema,
} from '../service/contracts.ts';

export const LocalCallSchema = z
  .object({
    to: NodeIdSchema,
    argv: z.array(z.string().min(1).max(MAX_ARG_BYTES)).min(1).max(MAX_ARG_COUNT),
    stdin: z.string().max(MAX_STDIN_BYTES).nullable().default(null),
    /** Absent = the node's configured default. A caller that knows its verb can block for minutes
     *  must declare that bound explicitly instead of relying on an unrelated default. */
    timeoutMs: z.number().int().min(1_000).max(MAX_COMMAND_TIMEOUT_MS).optional(),
  })
  .strict()
  .superRefine((call, ctx) =>
    addInputBoundIssues(ctx, { name: 'argv', values: call.argv, stdin: call.stdin }),
  );
export type LocalCall = z.infer<typeof LocalCallSchema>;

const LocalProfileStreamRequestSchema = z
  .strictObject({
    to: NodeIdSchema,
    profile: StreamProfileNameSchema,
    args: z.array(z.string().min(1).max(MAX_ARG_BYTES)).max(MAX_ARG_COUNT).default([]),
    stdin: z.string().max(MAX_STDIN_BYTES).nullable().default(null),
    cursor: z.string().min(1).max(512).nullable().default(null),
    timeoutMs: z.number().int().min(1_000).max(MAX_STREAM_TIMEOUT_MS).optional(),
  })
  .superRefine((request, ctx) =>
    addInputBoundIssues(ctx, { name: 'args', values: request.args, stdin: request.stdin }),
  );
const LocalServiceStreamRequestSchema = z.strictObject({
  to: NodeIdSchema,
  source: z.strictObject({
    kind: z.literal('service'),
    service: ServiceIdSchema,
    revision: ServiceRevisionSchema,
    operation: ServiceOperationIdSchema,
    payload: ServiceRequestPayloadSchema,
  }),
  // The owner declares its own lifetime and the wire accepts any positive one (`StreamOpenSchema`), so
  // the door does not narrow it to the one-second floor of command profiles.
  timeoutMs: z.number().int().min(1).max(MAX_STREAM_TIMEOUT_MS).optional(),
});
export const LocalStreamRequestSchema = z.union([
  LocalProfileStreamRequestSchema,
  LocalServiceStreamRequestSchema,
]);
export type LocalStreamRequest = z.infer<typeof LocalStreamRequestSchema>;

export const LocalEventPublishSchema = z
  .object({
    topic: TopicNameSchema,
    bootId: z.uuid(),
    seq: z.number().int().min(0),
    observedAt: z.iso.datetime().nullable().default(null),
    cursor: z.string().min(1).max(512).nullable().default(null),
    data: z.string().min(1).max(MAX_EVENT_BYTES),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (Buffer.byteLength(event.data) > MAX_EVENT_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['data'], message: `event exceeds ${MAX_EVENT_BYTES} bytes` });
    }
  });
export type LocalEventPublish = z.infer<typeof LocalEventPublishSchema>;

/** A local consumer may say where it left off. The agent tracks the cursor per broker lane on its
 *  own, so this is for a consumer that survived the agent — a panel restarting, a script rerun. */
export const LocalEventSubscribeSchema = z
  .object({
    topic: TopicNameSchema,
    resume: z
      .object({ bootId: z.uuid(), afterSeq: z.number().int().min(0) })
      .strict()
      .nullable()
      .default(null),
    /** Include handle admission and acknowledged-lane transitions in this feed. */
    lifecycle: z.boolean().optional(),
  })
  .strict();
export type LocalEventSubscribe = z.infer<typeof LocalEventSubscribeSchema>;
