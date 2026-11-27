import { z } from 'zod';
import { MAX_ARG_COUNT, MAX_COMMAND_TIMEOUT_MS, MAX_STDIN_BYTES } from './bounds.ts';
import { FailureSchema, RefusalFields, type Refused, refusalRefinement } from './failure.ts';
import { type NodeId, NodeIdSchema, nowIso } from './identity.ts';
import { addInputBoundIssues, BoundedArgSchema } from './payload.ts';
import { ResultFields, resultRefinement } from './result.ts';
export const InvocationSchema = z
  .object({
    id: z.uuid(),
    ts: z.string().max(64),
    from: NodeIdSchema,
    to: NodeIdSchema,
    /** An argv ARRAY, never a command string: no shell is involved anywhere in this path, so a
     *  session name containing ';' or '$' is data and stays data. */
    argv: z.array(BoundedArgSchema).min(1).max(MAX_ARG_COUNT),
    /** Body on stdin rather than in argv — arbitrary quotes and newlines cannot corrupt the call. */
    stdin: z.string().max(MAX_STDIN_BYTES).nullable(),
    /** The CALLER's deadline. The broker arms a slightly longer one so a late executor still loses
     *  to the caller's own clock rather than racing it. */
    timeoutMs: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_MS),
  })
  .strict()
  .superRefine((invocation, ctx) =>
    addInputBoundIssues(ctx, { name: 'argv', values: invocation.argv, stdin: invocation.stdin }),
  );
export type Invocation = z.infer<typeof InvocationSchema>;

export const ResultSchema = z.object(ResultFields).strict().superRefine(resultRefinement);
export type Result = z.infer<typeof ResultSchema>;

/** The broker's immediate answer to `rpc:call`: did the envelope get as far as a target socket?
 *  A rejection here is final and carries no `Result` — there was nothing to execute. */
export const AdmissionSchema = z
  .object({
    accepted: z.boolean(),
    failure: FailureSchema,
    ...RefusalFields,
    detail: z.string().max(4_096),
  })
  .strict()
  .superRefine(refusalRefinement);
export type Admission = z.infer<typeof AdmissionSchema>;

/**
 * The one place a version is checked. `version` is the node's release, and the broker refuses a
 * socket that does not match its own — so a half-finished rollout presents itself as a refusal on
 * the machine that was missed, rather than as unexplained behaviour on a fleet that looks healthy.
 */
export const HandshakeSchema = z
  .object({
    nodeId: NodeIdSchema,
    token: z.string().min(16).max(256),
    serves: z.boolean(),
    version: z.string().min(1).max(64),
  })
  .strict();
export type Handshake = z.infer<typeof HandshakeSchema>;

export function syntheticResult(id: string, refused: Refused, from: NodeId | 'broker' = 'broker'): Result {
  return {
    id,
    ts: nowIso(),
    from,
    code: 1,
    stdout: '',
    stderr: '',
    failure: refused.failure,
    refusal: refused.refusal,
    retryAfterMs: refused.retryAfterMs,
    transportCause: refused.transportCause,
    detail: refused.detail,
    truncated: false,
  };
}

/**
 * A caller withdrawing a call it is no longer waiting for.
 *
 * A command runs on another machine, and a caller that walked away would leave it running to its
 * own deadline — up to an hour of work nobody would read. `stream:cancel` says the same for a
 * stream; this says it for a unary call.
 */
export const CancelSchema = z
  .object({
    id: z.uuid(),
    from: NodeIdSchema,
    to: NodeIdSchema,
    reason: z.string().min(1).max(512),
  })
  .strict();
export type Cancel = z.infer<typeof CancelSchema>;
