import { readBoundedBody } from 'stitchkit/http';
import type { ClientSession, Operation } from './operation.ts';
import { WireClientError } from './errors.ts';
import { STREAMING_DOOR_PATHS, type DoorPath } from './door-paths.ts';
import { DOOR_MAX_REQUEST_BYTES } from '../../contracts/src/protocol/bounds.ts';
import { SERVICE_TRACE_HEADER } from '../../contracts/src/service/diagnostics.ts';

export type { DoorPath };

/** True when a request announces, in `content-length`, a body past `maxBytes`: refused before a byte is read. */
export function declaredLengthExceeds(headers: Headers, maxBytes: number): boolean {
  const declared = headers.get('content-length');
  return declared !== null && /^\d+$/.test(declared) && Number(declared) > maxBytes;
}

export function openDoor(
  session: ClientSession,
  operation: Operation,
  path: DoorPath,
  body?: unknown,
  signal?: AbortSignal,
  traceId?: string,
): Promise<Response> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined && Buffer.byteLength(payload) > DOOR_MAX_REQUEST_BYTES)
    throw new WireClientError('limit', 'Encoded Wire request exceeds byte limit', 'not-sent');
  if (operation.controller.signal.aborted) throw operation.error(undefined);
  operation.sent = true;
  return session.fetch(
    `http://wire.invalid${path}`,
    {
      method: body === undefined ? 'GET' : 'POST',
      body: payload,
      headers: {
        accept: 'application/json, application/x-ndjson',
        ...(traceId === undefined ? {} : { [SERVICE_TRACE_HEADER]: traceId }),
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      redirect: 'error',
      signal: signal ?? operation.controller.signal,
    },
    STREAMING_DOOR_PATHS.includes(path),
  );
}

export function checkResponse(response: Response, expected: 'json' | 'ndjson'): void {
  const status = response.status;
  if (status < 200 || status >= 300)
    throw new WireClientError(
      status === 404 ? 'unsupported' : 'http',
      'Local Wire HTTP request failed',
      'unknown',
      { status },
    );
  if (
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
    (expected === 'json' ? 'application/json' : 'application/x-ndjson')
  )
    throw new WireClientError('invalid-response', 'Unexpected Wire response content type', 'unknown');
}

export interface ReadJsonOptions {
  /** What the body is, in a refusal's message; `Wire response` by default. */
  label?: string;
  /** Stops the body read; the read then rejects with `abortError`. */
  signal?: AbortSignal;
  abortError?: (reason: unknown) => unknown;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The one bounded read of a JSON body: a declared length past `limit` is refused before a byte is
 * read, the body is read to at most `limit`, and its bytes must be strict UTF-8 JSON. A lossy decode
 * would let bytes the writer never sent parse as a value, so a bad byte is `invalid-response`.
 */
export async function readJson(
  response: Response,
  limit: number,
  options: ReadJsonOptions = {},
): Promise<unknown> {
  const label = options.label ?? 'Wire response';
  const limitError = () => new WireClientError('limit', `${label} exceeds byte limit`, 'unknown');
  if (declaredLengthExceeds(response.headers, limit)) throw limitError();
  const bytes = await readBoundedBody(response.body, {
    maxBytes: limit,
    signal: options.signal,
    limitError,
    abortError: options.abortError,
  });
  try {
    return JSON.parse(strictUtf8.decode(bytes));
  } catch (cause) {
    throw new WireClientError('invalid-response', `${label} is not valid UTF-8 JSON`, 'unknown', { cause });
  }
}
