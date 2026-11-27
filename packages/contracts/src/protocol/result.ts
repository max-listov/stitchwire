import { z } from 'zod';
import { MAX_STREAM_BYTES } from './bounds.ts';
import { FailureSchema, RefusalFields, refusalRefinement } from './failure.ts';
import { NodeIdSchema } from './identity.ts';
import { utf8ByteLength } from './payload.ts';

/** The fields of a finished call; the wire's `Result` and the door's `LocalResult` are built on them. */
export const ResultFields = {
  id: z.uuid(),
  ts: z.string().max(64),
  /** Who produced it. The broker itself for a failure raised before any node saw the call. */
  from: z.union([NodeIdSchema, z.literal('broker')]),
  code: z.number().int(),
  stdout: z.string().max(MAX_STREAM_BYTES),
  stderr: z.string().max(MAX_STREAM_BYTES),
  failure: FailureSchema,
  ...RefusalFields,
  detail: z.string().max(4_096),
  /** Set when a stream hit MAX_STREAM_BYTES, so a consumer never mistakes a cut answer for a
   *  complete one. */
  truncated: z.boolean(),
};

/** The same completed-call validation on wire, local door and forward-compatible SDK readers. */
export function resultRefinement(
  result: z.infer<z.ZodObject<typeof ResultFields>>,
  ctx: z.RefinementCtx,
): void {
  refusalRefinement(result, ctx);
  for (const field of ['stdout', 'stderr'] as const) {
    if (utf8ByteLength(result[field]) > MAX_STREAM_BYTES)
      ctx.addIssue({ code: 'custom', path: [field], message: `${field} exceeds ${MAX_STREAM_BYTES} bytes` });
  }
}
