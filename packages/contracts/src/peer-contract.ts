import { z } from 'zod';
import { LocalVersionSchema } from './door/common.ts';
import { NodeIdSchema } from './protocol/identity.ts';

const node = NodeIdSchema;
export const PEER_TIMEOUT_MS = 2_000;
export const PEER_FRESH_MS = 5_000;
export const PEER_WINDOW_MS = 60_000;
/** Probes in flight at once, per lane on a node and per caller on a broker. */
export const PEER_MAX_INFLIGHT = 8;
/** Probes admitted per minute, per identity on a broker and per node. */
export const PEER_MAX_PER_MINUTE = 60;
/** Routes and callers remembered at once. */
export const PEER_MAX_ROUTES = 128;
/** Round-trip samples kept per route inside the window. */
export const PEER_MAX_SAMPLES = 16;
export const PeerProbeSchema = z.object({ id: z.uuid(), to: node }).strict();
export const PeerEchoSchema = z.object({ id: z.uuid() }).strict();
export const PeerOutcomeSchema = z.enum([
  'ok',
  'offline',
  'denied',
  'timeout',
  'unsupported',
  'stale',
  'capacity',
]);
export const PeerReplySchema = z.object({ id: z.uuid(), outcome: PeerOutcomeSchema }).strict();
export type PeerOutcome = z.infer<typeof PeerOutcomeSchema>;
export type PeerReply = z.infer<typeof PeerReplySchema>;

export const PeerRequestSchema = z
  .object({
    to: node,
    route: z.string().min(1).max(64).optional(),
    mode: z.enum(['observe', 'cached']).default('observe'),
  })
  .strict();
export type PeerRequest = z.infer<typeof PeerRequestSchema>;
export const PeerObservationSchema = z
  .object({
    v: LocalVersionSchema,
    observer: node,
    target: node,
    route: z
      .object({ id: z.string().max(64), url: z.string().max(2048), epoch: z.string().max(256) })
      .strict()
      .nullable(),
    outcome: PeerOutcomeSchema,
    observedAt: z.iso.datetime().nullable(),
    freshnessMs: z.literal(PEER_FRESH_MS),
    ageMs: z.number().nonnegative().nullable(),
    aggregationWindowMs: z.literal(PEER_WINDOW_MS),
    sampleCount: z.number().int().min(0).max(16),
    latestMs: z.number().nonnegative().nullable(),
    medianMs: z.number().nonnegative().nullable(),
  })
  .strict();
export type PeerObservation = z.infer<typeof PeerObservationSchema>;
