import { z } from 'zod';
import { type BrokerHealth, BrokerHealthSchema, brokerHealthUrl } from './contracts.ts';
import { WireClientError } from './errors.ts';
import { errnoOf } from './errno.ts';
import { readJson } from './http.ts';

export const DEFAULT_BROKER_HEALTH_TIMEOUT_MS = 8_000;
export const DEFAULT_BROKER_HEALTH_MAX_BYTES = 8 * 1024 * 1024;

const ReadBrokerHealthOptionsSchema = z
  .object({
    timeoutMs: z.number().int().min(500).max(60_000).default(DEFAULT_BROKER_HEALTH_TIMEOUT_MS),
    maxResponseBytes: z
      .number()
      .int()
      .min(1)
      .max(DEFAULT_BROKER_HEALTH_MAX_BYTES)
      .default(DEFAULT_BROKER_HEALTH_MAX_BYTES),
  })
  .strict();

export type BrokerHealthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ReadBrokerHealthOptions {
  /** Total deadline for headers and body; defaults to 8 000 ms for cross-region TLS hops. */
  timeoutMs?: number;
  /** Maximum response payload bytes accepted; defaults to 8 MiB. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
  /** Optional fetch implementation override (for tests or custom TLS transports). */
  fetch?: BrokerHealthFetch;
}

const UNAVAILABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

/** Detect connection-refused/DNS errors across both Bun (direct `.code`) and Node/undici (`.cause` / `AggregateError.errors`). */
function isUnavailableNetworkError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  while (queue.length > 0 && seen.size < 32) {
    const current = queue.shift();
    if (typeof current !== 'object' || current === null || seen.has(current)) continue;
    seen.add(current);
    try {
      const code = errnoOf(current);
      if (code !== undefined && UNAVAILABLE_CODES.has(code)) return true;
      const cause = Reflect.get(current, 'cause');
      if (cause !== undefined) queue.push(cause);
      if (current instanceof AggregateError && Array.isArray(current.errors)) {
        for (const inner of current.errors) queue.push(inner);
      }
    } catch {
      // Ignore hostile getters while inspecting foreign transport errors.
    }
  }
  return false;
}

/**
 * Fetch and validate a broker's `/health` JSON snapshot with bounded timeout and response size.
 * Accepts `ws://`, `wss://`, `http://` or `https://` lane URLs; refuses redirects and malformed payloads.
 */
export async function readBrokerHealth(
  laneUrl: string,
  options: ReadBrokerHealthOptions = {},
): Promise<BrokerHealth> {
  const parsedOptions = ReadBrokerHealthOptionsSchema.safeParse({
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxResponseBytes === undefined ? {} : { maxResponseBytes: options.maxResponseBytes }),
  });
  if (!parsedOptions.success) {
    throw new WireClientError('invalid-request', 'Invalid readBrokerHealth options', 'not-sent', {
      cause: parsedOptions.error,
    });
  }
  let url: string;
  try {
    url = brokerHealthUrl(laneUrl);
  } catch (cause) {
    throw new WireClientError('invalid-request', 'Invalid broker lane URL', 'not-sent', { cause });
  }
  const { timeoutMs, maxResponseBytes } = parsedOptions.data;
  if (options.signal?.aborted) {
    throw new WireClientError('cancelled', 'Broker health request cancelled', 'not-sent', {
      cause: options.signal.reason,
    });
  }
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal =
    options.signal === undefined ? timeoutSignal : AbortSignal.any([options.signal, timeoutSignal]);
  const fetchFn = options.fetch ?? globalThis.fetch;
  let response: Response | undefined;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      throw new WireClientError('http', `Broker health returned HTTP ${response.status}`, 'unknown', {
        status: response.status,
      });
    }
    if (response.body === null) {
      throw new WireClientError('invalid-response', 'Broker health response has no body', 'unknown');
    }
    const payload = await readJson(response, maxResponseBytes, {
      label: 'Broker health response',
      signal,
      abortError: () =>
        options.signal?.aborted
          ? new WireClientError('cancelled', 'Broker health request cancelled', 'unknown', {
              cause: options.signal.reason,
            })
          : new WireClientError('timeout', 'Broker health request timed out', 'unknown', {
              cause: timeoutSignal.reason,
            }),
    });
    const validated = BrokerHealthSchema.safeParse(payload);
    if (!validated.success) {
      throw new WireClientError(
        'invalid-response',
        'Broker health payload failed schema validation',
        'unknown',
        { cause: validated.error },
      );
    }
    return validated.data;
  } catch (error) {
    if (error instanceof WireClientError) throw error;
    if (options.signal?.aborted) {
      throw new WireClientError('cancelled', 'Broker health request cancelled', 'unknown', {
        cause: error,
      });
    }
    if (timeoutSignal.aborted || (error instanceof Error && error.name === 'TimeoutError')) {
      throw new WireClientError('timeout', 'Broker health request timed out', 'unknown', {
        cause: error,
      });
    }
    if (isUnavailableNetworkError(error)) {
      throw new WireClientError('unavailable', 'Broker health endpoint is unavailable', 'not-sent', {
        cause: error,
      });
    }
    throw new WireClientError('transport', 'Broker health request failed', 'unknown', { cause: error });
  } finally {
    if (response?.body && !response.body.locked) {
      await response.body.cancel().catch(() => undefined);
    }
  }
}
