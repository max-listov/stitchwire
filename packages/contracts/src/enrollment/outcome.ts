import { z } from 'zod';
import { NodeIdSchema } from '../protocol/identity.ts';

/** Refusals every enrollment operation shares, whichever side executes it. */
export const EnrollmentCommonCodeSchema = z.enum([
  'invalid-request',
  'request-conflict',
  'version-mismatch',
  'credential-conflict',
  'broker-unavailable',
  'busy',
  'state-invalid',
  'io-failed',
]);

/**
 * What every operation result says before its own outcome: the request and operation it answers,
 * when it was observed, and what the request's journal holds across its runs.
 */
export function resultShell<Operation extends z.ZodType, Phase extends z.ZodType, Failure extends z.ZodType>(
  operation: Operation,
  phase: Phase,
  failure: Failure,
) {
  return {
    v: z.literal(1),
    /** Null when the request could not be read. */
    requestId: z.uuid().nullable(),
    nodeId: NodeIdSchema.nullable(),
    /** Null when the command named no valid operation. */
    operation: operation.nullable(),
    observedAt: z.iso.datetime(),
    /** Phases this request completed, from its journal; a read-only operation reports none. */
    completed: z.array(phase),
    /** The first refusal this request met; a later success keeps it as recovery evidence. */
    firstFailure: failure.nullable(),
  };
}
