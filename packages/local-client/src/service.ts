import { readBoundedBody } from 'stitchkit/http';
import { z } from 'zod';
import { TRANSPORT_CAUSES } from '../../contracts/src/protocol/failure.ts';
import { NodeIdSchema } from '../../contracts/src/protocol/identity.ts';
import { serviceOperationTimeout } from '../../contracts/src/service/budgets.ts';
import { type ServiceOutcome, ServiceRequestPayloadSchema } from '../../contracts/src/service/contracts.ts';
import {
  type ServiceDescriptor,
  ServiceDescriptorSchema,
} from '../../contracts/src/service/policy-schema.ts';
import type { WireClient } from './client.ts';
import { WireClientError } from './errors.ts';
import { declaredLengthExceeds } from './http.ts';
import type { StreamItem } from './readers.ts';
import { SERVICE_TRACE_HEADER, type ServiceClientTrace } from '../../contracts/src/service/diagnostics.ts';

export class WireServiceError extends Error {
  constructor(
    readonly outcome: Extract<ServiceOutcome, { status: 'failure' }>,
    readonly traceId?: string,
  ) {
    super(`Wire service ${outcome.code}`);
    this.name = 'WireServiceError';
  }
  get delivery() {
    return this.outcome.delivery;
  }
  get transportCause() {
    return this.outcome.transportCause ?? null;
  }
  get refusal() {
    return this.outcome.refusal;
  }
  get detail() {
    return this.outcome.detail ?? null;
  }
  get cancellationOrigin() {
    return this.outcome.cancellationOrigin;
  }
  get diagnostics() {
    return this.outcome.diagnostics;
  }
}

/**
 * The `result` that closes a unary call's `start` when no outcome was received: the request body was
 * refused, or the client threw. A caller that pairs the two sees a call that ended, not one still open.
 * What is known of how it ended rides with it.
 */
function endedWithoutOutcome(traceId: string, error: unknown): ServiceClientTrace {
  const diagnostics = error instanceof WireServiceError ? error.diagnostics : undefined;
  const origin =
    error instanceof WireServiceError
      ? error.cancellationOrigin
      : error instanceof WireClientError
        ? error.metadata.cancellationOrigin
        : undefined;
  return {
    traceId,
    phase: 'result',
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(origin === undefined ? {} : { cancellationOrigin: origin }),
  };
}

function invalidRequest(detail: string): WireServiceError {
  return new WireServiceError({
    status: 'failure',
    code: 'invalid-request',
    delivery: 'not-dispatched',
    retryAfterMs: null,
    transportCause: null,
    refusal: 'request',
    detail,
  });
}

function cancelledRequest(): WireServiceError {
  return new WireServiceError({
    status: 'failure',
    code: 'cancelled',
    cancellationOrigin: 'caller-abort',
    delivery: 'not-dispatched',
    retryAfterMs: null,
    transportCause: null,
    refusal: 'none',
    detail: 'service request body consumption was cancelled',
  });
}

async function readRequestText(request: Request, maxBytes: number): Promise<string> {
  if (declaredLengthExceeds(request.headers, maxBytes))
    throw invalidRequest('service request body exceeds its declared byte limit');
  const bytes = await readBoundedBody(request.body, {
    maxBytes,
    signal: request.signal,
    limitError: () => invalidRequest('service request body exceeds its declared byte limit'),
    abortError: cancelledRequest,
  });
  if (request.body === null) return '{}';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidRequest('service request body is not UTF-8');
  }
}

function streamFailure(
  item: Exclude<StreamItem, { kind: 'chunk' }>,
): Extract<ServiceOutcome, { status: 'failure' }> {
  if (item.kind === 'end') {
    const code =
      item.frame.reason === 'cancelled'
        ? 'cancelled'
        : item.frame.reason === 'timeout'
          ? 'timeout'
          : item.frame.reason === 'unsupported'
            ? 'unsupported'
            : item.frame.reason === 'limit'
              ? 'invalid-response'
              : 'unavailable';
    return {
      status: 'failure',
      code,
      delivery: 'unknown',
      retryAfterMs: null,
      transportCause: null,
      refusal: 'none',
      detail: `service stream ended with ${item.frame.reason}`,
    };
  }
  const { frame } = item;
  const code =
    frame.refusal === 'capacity'
      ? 'capacity'
      : frame.refusal === 'request'
        ? 'invalid-request'
        : frame.failure === 'offline'
          ? 'offline'
          : frame.failure === 'denied'
            ? 'denied'
            : frame.failure === 'timeout'
              ? 'timeout'
              : frame.failure === 'cancelled'
                ? 'cancelled'
                : frame.failure === 'rejected'
                  ? 'invalid-request'
                  : 'unavailable';
  const notDispatched =
    frame.refusal !== 'none' ||
    frame.failure === 'offline' ||
    frame.failure === 'denied' ||
    frame.failure === 'rejected' ||
    (frame.transportCause != null && TRANSPORT_CAUSES[frame.transportCause].delivery === 'not-dispatched');
  return {
    status: 'failure',
    code,
    delivery: notDispatched ? 'not-dispatched' : 'unknown',
    retryAfterMs: frame.retryAfterMs,
    transportCause: frame.transportCause ?? null,
    refusal: frame.refusal,
    detail: frame.detail,
  };
}
const BindingSchema = z.strictObject({
  to: NodeIdSchema,
  baseUrl: z.url(),
  descriptor: ServiceDescriptorSchema,
});

/** Virtual owner URLs select declared operations; never a network fetch or an endpoint discovery. */
export function createServiceFetch(
  client: Pick<WireClient, 'invokeService' | 'stream'>,
  binding: {
    to: string;
    baseUrl: string;
    descriptor: ServiceDescriptor;
    onTrace?: (trace: ServiceClientTrace) => void;
  },
): (input: string | Request | URL, init?: RequestInit) => Promise<Response> {
  if (typeof client.invokeService !== 'function' || typeof client.stream !== 'function')
    throw new TypeError('Wire service adapter requires invokeService and stream capabilities');
  const { onTrace, ...definition } = binding;
  const config = BindingSchema.parse(definition);
  const origin = new URL(config.baseUrl).origin;
  return async (input, init) => {
    const request =
      input instanceof Request
        ? init === undefined
          ? input
          : new Request(input, init)
        : new Request(String(input), init);
    const url = new URL(request.url);
    const operation = config.descriptor.operations.find((entry) => url.pathname === entry.path);
    if (
      url.origin !== origin ||
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      request.method !== 'POST' ||
      !operation
    )
      throw invalidRequest('request does not match a declared virtual service operation');
    const traceId = crypto.randomUUID();
    if (operation.response.kind === 'unary') onTrace?.({ traceId, phase: 'start' });
    let body: string;
    try {
      body = await readRequestText(request, operation.limits.requestBytes);
      if (!ServiceRequestPayloadSchema.safeParse(body).success)
        throw invalidRequest('service request body is not a JSON document');
    } catch (error) {
      if (operation.response.kind === 'unary') {
        onTrace?.(endedWithoutOutcome(traceId, error));
        if (error instanceof WireServiceError) throw new WireServiceError(error.outcome, traceId);
      }
      throw error;
    }
    if (operation.response.kind === 'stream') {
      const feed = client.stream(
        {
          to: config.to,
          source: {
            kind: 'service',
            service: config.descriptor.service,
            revision: config.descriptor.revision,
            operation: operation.id,
            payload: body,
          },
          timeoutMs: serviceOperationTimeout(operation),
        },
        { signal: request.signal },
      );
      return new Response(
        new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              try {
                const next = await feed.next();
                if (next.done) {
                  controller.close();
                  return;
                }
                if (next.value.kind === 'chunk') {
                  controller.enqueue(next.value.data);
                  return;
                }
                if (next.value.kind === 'end' && next.value.frame.reason === 'completed') {
                  controller.close();
                  return;
                }
                controller.error(new WireServiceError(streamFailure(next.value)));
              } catch (error) {
                controller.error(error);
              }
            },
            cancel() {
              feed.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
      );
    }
    const { outcome } = await client
      .invokeService(
        {
          traceId,
          to: config.to,
          service: config.descriptor.service,
          revision: config.descriptor.revision,
          operation: operation.id,
          payload: body,
          timeoutMs: operation.limits.timeoutMs,
        },
        { signal: request.signal },
      )
      .catch((error: unknown) => {
        onTrace?.(endedWithoutOutcome(traceId, error));
        throw error;
      });
    onTrace?.({
      traceId,
      phase: 'result',
      diagnostics: outcome.diagnostics,
      ...(outcome.status === 'failure' ? { cancellationOrigin: outcome.cancellationOrigin } : {}),
    });
    if (outcome.status === 'failure') throw new WireServiceError(outcome, traceId);
    return new Response(outcome.payload, {
      status: outcome.httpStatus,
      headers: { 'content-type': 'application/json', [SERVICE_TRACE_HEADER]: traceId },
    });
  };
}
