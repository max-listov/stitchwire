import { z } from 'zod';
import { FleetKeyIdSchema, FleetSerialSchema } from './identity.ts';

/**
 * Whether the configuration this process runs matches the edition it keeps.
 *
 * `unconfigured` — no fleet trust is configured, and the configuration is edited by hand.
 * `unknown` — trust is configured, but there is no verified edition to compare with yet.
 * `aligned` — the fleet tables on disk are exactly the projection of the kept edition.
 * `drifted` — they differ and could not be rewritten; `detail` says why.
 */
export const FleetConfigStateSchema = z.enum(['unconfigured', 'unknown', 'aligned', 'drifted']);
export type FleetConfigState = z.infer<typeof FleetConfigStateSchema>;

export const FleetEditionStatusSchema = z.strictObject({
  serial: FleetSerialSchema.nullable(),
  issuedAt: z.iso.datetime().nullable(),
  signer: FleetKeyIdSchema.nullable(),
  config: FleetConfigStateSchema,
  detail: z.string().max(1024).nullable(),
  checkedAt: z.iso.datetime().nullable(),
});
export type FleetEditionStatus = z.infer<typeof FleetEditionStatusSchema>;

/** A node's view: its own copy, and the edition each of its brokers answered with. */
export const FleetNodeStatusSchema = FleetEditionStatusSchema.extend({
  copy: z.enum(['none', 'full', 'own']),
  lanes: z.array(
    z.strictObject({
      lane: z.string(),
      serial: FleetSerialSchema.nullable(),
      syncedAt: z.iso.datetime(),
      detail: z.string().max(512).nullable(),
    }),
  ),
});
export type FleetNodeStatus = z.infer<typeof FleetNodeStatusSchema>;
