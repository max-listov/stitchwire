import { z } from 'zod';
import { SLUG_PATTERN } from '../protocol/identity.ts';

/** Monotonic per fleet: a node accepts only a bundle newer than the one it keeps. */
export const FleetSerialSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

export const FleetKeyIdSchema = z.string().regex(SLUG_PATTERN, 'a key id is a lowercase slug');
