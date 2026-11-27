import type { z } from 'zod';
import type { ClientSession } from './operation.ts';
import { checkResponse, openDoor, readJson, type DoorPath } from './http.ts';
import { readResponse } from './readers.ts';
import { WireClientError } from './errors.ts';

export async function unary<T>(
  session: ClientSession,
  path: DoorPath,
  body: unknown,
  schema: z.ZodType<T>,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    versioned: boolean;
    maxBytes?: number;
    traceId?: string;
  },
): Promise<T> {
  const operation = session.begin(options.signal);
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let headersMs: number | null = null;
  let phase: 'dispatch' | 'headers' | 'body' = 'dispatch';
  operation.deadline(options.timeoutMs);
  let response: Response | undefined;
  try {
    response = await openDoor(session, operation, path, body, undefined, options.traceId);
    headersMs = performance.now() - start;
    phase = 'headers';
    checkResponse(response, 'json');
    phase = 'body';
    const raw = await readJson(
      response,
      Math.min(options.maxBytes ?? session.options.maxResponseBytes, session.options.maxResponseBytes),
    );
    return readResponse(schema, raw, options.versioned);
  } catch (error) {
    const failure = operation.error(error);
    throw new WireClientError(failure.code, failure.message, failure.delivery, {
      ...failure.metadata,
      timing: {
        startedAt,
        elapsedMs: performance.now() - start,
        headersMs,
        timeoutMs: options.timeoutMs,
        phase,
        callerAborted: options.signal?.aborted ?? false,
      },
    });
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    operation.finish();
  }
}
