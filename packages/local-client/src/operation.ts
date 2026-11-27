import { createBoundedAdmission } from 'stitchkit/application';
import { createUnixClientTransport } from 'stitchkit/server';
import { DOOR_MAX_REQUEST_BYTES, MAX_COMMAND_TIMEOUT_MS } from '../../contracts/src/protocol/bounds.ts';
import { type ClientErrorCode, localError, WireClientError } from './errors.ts';
import { COMMAND_RESULT_GRACE_MS, type ResolvedOptions } from './options.ts';

/**
 * The transport's own wait for unary headers. It is a backstop against a door that never answers,
 * never the deadline: it sits strictly past the longest operation deadline a caller can set, so the
 * caller's deadline always fires first and a call at the boundary ends with one verdict —
 * `timeout` from the caller's deadline — instead of whichever of two equal timers ran first.
 */
export const UNARY_HEADERS_TIMEOUT_MS = MAX_COMMAND_TIMEOUT_MS + COMMAND_RESULT_GRACE_MS + 5_000;

export class Operation {
  readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private external: AbortSignal | undefined;
  private readonly externalAbort = (): void => this.abort('cancelled');
  private finished = false;
  sent = false;

  constructor(private readonly release: () => void) {}

  listen(signal?: AbortSignal): void {
    this.external = signal;
    if (signal?.aborted) this.abort('cancelled');
    else signal?.addEventListener('abort', this.externalAbort, { once: true });
  }

  deadline(ms: number): void {
    this.clearDeadline();
    this.timer = setTimeout(() => this.abort('timeout'), ms);
    this.timer.unref();
  }

  clearDeadline(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  abort(code: ClientErrorCode): void {
    this.controller.abort(
      new WireClientError(code, `Wire operation ${code}`, this.sent ? 'unknown' : 'not-sent', {
        ...(code === 'timeout'
          ? { cancellationOrigin: 'caller-deadline' }
          : code === 'cancelled'
            ? { cancellationOrigin: 'caller-abort' }
            : {}),
      }),
    );
    this.finish();
  }

  error(error: unknown): WireClientError {
    const reason: unknown = this.controller.signal.reason;
    return reason instanceof WireClientError ? reason : localError(error, this.sent ? 'unknown' : 'not-sent');
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.clearDeadline();
    this.external?.removeEventListener('abort', this.externalAbort);
    this.external = undefined;
    this.release();
  }
}

export class ClientSession {
  private readonly transport;
  private readonly streaming;
  private readonly admission;
  private closed = false;
  private readonly active = new Set<Operation>();

  constructor(readonly options: ResolvedOptions) {
    this.admission = createBoundedAdmission({
      policy: { global: { maxConcurrent: options.maxConcurrentRequests } },
    });
    const config = {
      socketPath: options.socketPath,
      maxConnections: options.maxConcurrentRequests,
      maxRequestBytes: DOOR_MAX_REQUEST_BYTES,
      maxHeaderBytes: 65536,
      maxRedirects: 0,
    };
    // Unary headers arrive after execution; each Operation enforces its own whole-response deadline.
    this.transport = createUnixClientTransport({
      ...config,
      headersTimeoutMs: UNARY_HEADERS_TIMEOUT_MS,
      maxResponseBytes: options.maxResponseBytes,
    });
    this.streaming = createUnixClientTransport({
      ...config,
      headersTimeoutMs: options.openTimeoutMs,
      responseBodyMode: 'streaming',
    });
  }

  begin(signal?: AbortSignal): Operation {
    if (this.closed) throw new WireClientError('closed', 'Wire client is closed', 'not-sent');
    const admitted = this.admission.acquire();
    if (admitted.outcome === 'refused')
      throw new WireClientError('capacity', 'Wire client concurrency limit reached', 'not-sent');
    const operation = new Operation(() => {
      this.active.delete(operation);
      admitted.lease.release();
    });
    this.active.add(operation);
    operation.listen(signal);
    return operation;
  }

  fetch(url: string, init: RequestInit, streaming: boolean): Promise<Response> {
    return (streaming ? this.streaming : this.transport).fetch(url, init);
  }

  close(): void {
    this.closed = true;
    this.admission.stopAdmission();
    for (const operation of this.active) {
      operation.abort('closed');
      operation.finish();
    }
    void this.transport.close();
    void this.streaming.close();
  }
}
