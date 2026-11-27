import { z } from 'zod';

/** A lowercase slug of at most 32 characters: how nodes, lanes and signing keys are named. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const NodeIdSchema = z
  .string()
  .regex(SLUG_PATTERN, 'node id must be a lowercase slug (alpha, worker-1)');
export type NodeId = z.infer<typeof NodeIdSchema>;

/** Brokers one node dials at most: each is a lane it authenticates on and keeps connected. */
export const MAX_NODE_BROKERS = 8;

/** A command a node declares and a broker grant names: one slug-like name, never a pattern. */
export const CommandNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    'a command is named by a lowercase slug (a-z, 0-9, ".", "_", "-"), never a pattern',
  );

/** Wall-clock label only, not a cross-host latency measurement. */
export function nowIso(): string {
  return new Date().toISOString();
}
