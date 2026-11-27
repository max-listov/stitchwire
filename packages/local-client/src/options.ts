import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  DOOR_MAX_FRAME_BYTES,
  DOOR_MAX_RESPONSE_BYTES,
  MAX_STREAM_TIMEOUT_MS,
} from '../../contracts/src/protocol/bounds.ts';
import { WireClientError } from './errors.ts';

export const COMMAND_RESULT_GRACE_MS = 10_000;
/** How long past its declared lifetime a stream may take to deliver its terminal frame. */
export const STREAM_TERMINAL_GRACE_MS = 10_000;

export const ClientOptionsSchema = z
  .object({
    socketPath: z
      .string()
      .min(1)
      .refine((p) => isAbsolute(p) && !p.includes('\0'), 'absolute Unix socket path required'),
    timeoutMs: z.number().int().min(1_000).max(MAX_STREAM_TIMEOUT_MS).default(30_000),
    openTimeoutMs: z.number().int().min(1).max(60_000).default(10_000),
    maxConcurrentRequests: z.number().int().min(1).max(256).default(32),
    maxResponseBytes: z.number().int().min(1).max(DOOR_MAX_RESPONSE_BYTES).default(DOOR_MAX_RESPONSE_BYTES),
    maxFrameBytes: z.number().int().min(1).max(DOOR_MAX_FRAME_BYTES).default(DOOR_MAX_FRAME_BYTES),
  })
  .strict();
export type WireClientOptions = z.input<typeof ClientOptionsSchema>;
export type ResolvedOptions = z.output<typeof ClientOptionsSchema>;
export interface RequestOptions {
  signal?: AbortSignal;
}

export function requestInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new WireClientError('invalid-request', 'Invalid Wire client request', 'not-sent', {
      cause: result.error,
    });
  return result.data;
}
