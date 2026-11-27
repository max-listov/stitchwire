import { UnixClientTransportError } from 'stitchkit/server';
import { ApiError, StreamTruncatedLineError } from 'stitchkit';
import {
  type ClientErrorCode,
  ClientErrorCodeSchema,
  type DeliveryCertainty,
} from '../../contracts/src/door/client-error.ts';
import type { ServiceCancellationOrigin } from '../../contracts/src/service/diagnostics.ts';
import { errnoOf } from './errno.ts';

export { type ClientErrorCode, ClientErrorCodeSchema, type DeliveryCertainty };

/** Local failure is not a remote command's exit code or a proof of non-execution. */
export class WireClientError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly delivery: DeliveryCertainty,
    readonly metadata: {
      status?: number;
      actualVersion?: number;
      cause?: unknown;
      traceId?: string;
      cancellationOrigin?: ServiceCancellationOrigin;
      timing?: {
        startedAt: string;
        elapsedMs: number;
        headersMs: number | null;
        timeoutMs: number;
        phase: 'dispatch' | 'headers' | 'body';
        callerAborted: boolean;
      };
    } = {},
  ) {
    super(message, { cause: metadata.cause });
    this.name = 'WireClientError';
  }
}

export function localError(error: unknown, delivery: DeliveryCertainty): WireClientError {
  if (error instanceof WireClientError) return error;
  if (error instanceof ApiError) {
    if (error.cause instanceof WireClientError) return error.cause;
    const code: ClientErrorCode =
      error.code === 'STREAM_TERMINAL_MISSING' || error.code === 'STREAM_TRUNCATED'
        ? 'unexpected-eof'
        : error.code === 'REQUEST_TIMEOUT'
          ? 'timeout'
          : error.code === 'REQUEST_ABORTED'
            ? 'cancelled'
            : 'invalid-response';
    return new WireClientError(code, 'Wire stream failed', delivery, { cause: error });
  }
  if (error instanceof RangeError)
    return new WireClientError('limit', 'Wire frame exceeds byte limit', delivery, { cause: error });
  if (error instanceof SyntaxError || error instanceof TypeError) {
    const code = error instanceof StreamTruncatedLineError ? 'unexpected-eof' : 'invalid-response';
    return new WireClientError(code, 'Invalid Wire stream frame', delivery, { cause: error });
  }
  if (error instanceof UnixClientTransportError) {
    if (error.code === 'UNIX_TARGET_REFUSED')
      return new WireClientError('permission', 'Local Wire socket target refused', 'not-sent', {
        cause: error,
      });
    const code: ClientErrorCode =
      error.code === 'UNIX_CONNECT_FAILED'
        ? 'unavailable'
        : error.code === 'UNIX_CONNECTION_LIMIT'
          ? 'capacity'
          : error.code === 'UNIX_HEADERS_TIMEOUT'
            ? 'timeout'
            : error.code === 'UNIX_RESPONSE_TOO_LARGE' || error.code === 'UNIX_REQUEST_TOO_LARGE'
              ? 'limit'
              : error.code === 'UNIX_REDIRECT_REFUSED'
                ? 'http'
                : error.code === 'UNIX_HEADERS_TOO_LARGE'
                  ? 'invalid-response'
                  : 'transport';
    return new WireClientError(
      code,
      'Local Wire transport failed',
      error.delivery === 'not-dispatched' ? 'not-sent' : 'unknown',
      { cause: error },
    );
  }
  const code = errnoOf(error);
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'FailedToOpenSocket') {
    return new WireClientError('unavailable', 'Local Wire agent is unavailable', 'not-sent', {
      cause: error,
    });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return new WireClientError('permission', 'Local Wire socket access denied', 'not-sent', { cause: error });
  }
  return new WireClientError('transport', 'Local Wire connection failed', delivery, { cause: error });
}
