import { z } from 'zod';
import { RealtimeRequestPhaseSchema, type RealtimeRequestPhaseHook } from 'stitchkit';
import type { LocalEventPublish } from '../../../contracts/src/door/requests.ts';
import { NodeIdSchema } from '../../../contracts/src/protocol/identity.ts';
import { TopicNameSchema } from '../../../contracts/src/protocol/event.ts';
import type { Audit } from '../broker/audit.ts';

export const PublicationTraceSchema = z
  .object({
    kind: z.literal('publication-phase'),
    producer: NodeIdSchema,
    topic: TopicNameSchema,
    bootId: z.uuid(),
    seq: z.number().int().nonnegative(),
    phase: z.union([
      z.enum(['door-received', 'lane-dispatch', 'lane-result', 'door-response-ready']),
      RealtimeRequestPhaseSchema,
    ]),
    requestId: z.string().min(1).max(128).optional(),
    lane: z.string().max(128).nullable(),
    elapsedMs: z.number().nonnegative(),
    outcome: z.enum(['pending', 'accepted', 'refused', 'failed']),
    callerAborted: z.boolean(),
  })
  .strict();
type PublicationTrace = z.infer<typeof PublicationTraceSchema>;
export type TracePublication = (
  request: Pick<LocalEventPublish, 'topic' | 'bootId' | 'seq'>,
  phase: PublicationTrace['phase'],
  fields: Pick<PublicationTrace, 'elapsedMs'> &
    Partial<Pick<PublicationTrace, 'lane' | 'outcome' | 'callerAborted' | 'requestId'>>,
) => void;

/** Exact projection, never request spread: payload, cursor, headers and credentials stay out. */
export function publicationTrace(audit: Audit, producer: string): TracePublication {
  return (request, phase, fields) =>
    audit.write(
      PublicationTraceSchema.parse({
        kind: 'publication-phase',
        producer,
        topic: request.topic,
        bootId: request.bootId,
        seq: request.seq,
        phase,
        ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
        lane: fields.lane ?? null,
        // Required, not defaulted. Every call site already measures — `door-received` passes a
        // truthful 0 because that is where measurement starts — so the fallback never ran. What it
        // did instead is describe the system wrongly: a reader sees "an unmeasured phase is
        // recorded as instant", and would be right to distrust every 0 in the journal. An
        // unreachable default is not harmless; it is a false statement about what the data means.
        elapsedMs: fields.elapsedMs,
        outcome: fields.outcome ?? 'pending',
        callerAborted: fields.callerAborted ?? false,
      }),
    );
}

/** Only the immutable transport tuple is retained by the request-scoped hook. */
export function publicationRequestObserver(
  trace: TracePublication | undefined,
  request: Pick<LocalEventPublish, 'topic' | 'bootId' | 'seq'>,
  lane: string,
): RealtimeRequestPhaseHook | undefined {
  if (!trace) return undefined;
  const tuple = { topic: request.topic, bootId: request.bootId, seq: request.seq };
  return (phase) => {
    trace(tuple, phase.phase, {
      lane,
      requestId: phase.requestId,
      elapsedMs: phase.elapsedMs,
    });
  };
}
