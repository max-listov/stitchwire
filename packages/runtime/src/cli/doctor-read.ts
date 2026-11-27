import type { z } from 'zod';
import { readBrokerHealth } from '../../../local-client/src/broker-health.ts';
import type { BrokerHealth } from '../../../local-client/src/contracts.ts';
import { WireClientError } from '../../../local-client/src/errors.ts';
import { readJson } from '../../../local-client/src/http.ts';

export class DiagnosticReadError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** How long one observation, headers and body together, may take before doctor reports it unknown. */
export const OBSERVATION_DEADLINE_MS = 5000;

/** The largest observation doctor reads; a status of a full fleet is far below it. */
const OBSERVATION_MAX_BYTES = 8 * 1024 * 1024;

/** How the SDK's bounded JSON reader refuses a body, restated as doctor's diagnostic codes. */
const BODY_READ_CODES: Readonly<Record<string, string>> = {
  limit: 'observation.limit',
  'invalid-response': 'observation.json',
};

/**
 * One read, including headers and body, through the same bounded JSON reader the SDK uses; error
 * details never reproduce remote data or credentials, and each refusal keeps its cause.
 */
export async function readDoctorObservation<T>(url: string, schema: z.ZodType<T>, unix?: string): Promise<T> {
  let response: Response | undefined;
  try {
    response = await fetch(url, {
      unix,
      redirect: 'error',
      signal: AbortSignal.timeout(OBSERVATION_DEADLINE_MS),
    });
    if (!response.ok)
      throw new DiagnosticReadError('observation.http', `Observation returned HTTP ${response.status}`);
    if (!response.body) throw new DiagnosticReadError('observation.body', 'Observation has no body');
    let value: unknown;
    try {
      value = await readJson(response, OBSERVATION_MAX_BYTES);
    } catch (cause) {
      const code = cause instanceof WireClientError ? BODY_READ_CODES[cause.code] : undefined;
      if (code === undefined) throw cause;
      throw new DiagnosticReadError(
        code,
        code === 'observation.limit'
          ? 'Observation exceeds eight MiB'
          : 'Observation is not valid UTF-8 JSON',
        { cause },
      );
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new DiagnosticReadError(
        'observation.schema',
        'Observation does not satisfy the required diagnostic schema',
        { cause: parsed.error },
      );
    return parsed.data;
  } catch (error) {
    if (error instanceof DiagnosticReadError) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name))
      throw new DiagnosticReadError('observation.timeout', 'Observation exceeded the five-second deadline', {
        cause: error,
      });
    throw new DiagnosticReadError(
      'observation.transport',
      'Observation endpoint is unavailable or refused the transport request',
      { cause: error },
    );
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}

const BROKER_READ_CODES: Readonly<Record<string, string>> = {
  timeout: 'observation.timeout',
  http: 'observation.http',
  limit: 'observation.limit',
  'invalid-response': 'observation.schema',
};

/**
 * A broker's `/health`, read the way every other reader of it does: through the SDK reader, which
 * tolerates fields and enumerated values a broker of another release adds, under doctor's own
 * deadline. Its refusal is restated as a diagnostic code; the message names the failure, never the
 * remote body.
 */
export async function readBrokerObservation(laneUrl: string): Promise<BrokerHealth> {
  try {
    return await readBrokerHealth(laneUrl, { timeoutMs: OBSERVATION_DEADLINE_MS });
  } catch (error) {
    if (!(error instanceof WireClientError)) throw error;
    throw new DiagnosticReadError(BROKER_READ_CODES[error.code] ?? 'observation.transport', error.message, {
      cause: error,
    });
  }
}
