import { SERVICE_MAX_TIMEOUT_MS, ServiceIngressSchema } from '../../contracts/src/service/contracts.ts';
import { serviceOperationTimeout } from '../../contracts/src/service/budgets.ts';
import {
  type ServiceDescriptor,
  ServiceDescriptorSchema,
} from '../../contracts/src/service/policy-schema.ts';
import { SERVICE_TRACE_HEADER } from '../../contracts/src/service/diagnostics.ts';
import { jsonEnvelopeBytes } from '../../contracts/src/protocol/json-bounds.ts';
import { readBoundedBody } from 'stitchkit/http';
import { defineRequestIngress } from 'stitchkit/server';
import { z } from 'zod';
import { declaredLengthExceeds } from './http.ts';

/** What the node established about one delivered call; the owner's handler cannot learn it from headers. */
export interface ServiceCaller {
  readonly caller: string;
  readonly operation: string;
  readonly id: string;
  readonly traceId: string;
}

/**
 * Stitchkit's request-ingress channel: only the code holding this key can attach or read a value. A
 * header, a cloned Request or a Request any other entrance constructs carries none, so a caller
 * identity cannot be forged by a request that did not pass the envelope check below.
 */
const delivered = defineRequestIngress<ServiceCaller>('stitchwire.service-caller');

/**
 * The node-authenticated caller of the request an endpoint received from `createServiceIngress`;
 * `undefined` for any other. The parameter is structural so that a Node consumer's declarations do not pull Stitchkit's server types (they need Bun's); `source` is the endpoint context (`authorize`, `beforeHandle`, a handler or `onError`).
 */
export function serviceCaller(source: { readonly req?: Request | undefined }): ServiceCaller | undefined {
  return delivered.from(source);
}

const TraceIdSchema = z.uuid();
const BodyTimeoutSchema = z.int().min(1).max(SERVICE_MAX_TIMEOUT_MS);
const envelopeText = new TextDecoder('utf-8', { fatal: true });

function refusal(detail: string): Response {
  // A refusal is an owner HTTP answer, not a Wire code: Wire passes status and JSON body through.
  return Response.json({ error: 'invalid-request', detail }, { status: 400 });
}

/**
 * Turns the node's envelope POST into the owner's own Stitchkit request.
 *
 * The returned fetch handler is the whole door of a service owner: it answers `invalid-request` (400)
 * without calling `handler` for anything the descriptor does not declare, and otherwise calls
 * `handler` with `POST <operation path>` and the payload as its JSON body.
 *
 * `bodyTimeoutMs` bounds only the read of the envelope: a body not complete within it is cancelled and
 * answered `invalid-request` without calling `handler`. It ends when the envelope is read; `handler`, a
 * streamed response and the node's cancellation on `request.signal` are not under it.
 */
export function createServiceIngress(options: {
  descriptor: ServiceDescriptor;
  handler: (request: Request) => Response | Promise<Response>;
  bodyTimeoutMs?: number;
}): (request: Request) => Promise<Response> {
  const descriptor = ServiceDescriptorSchema.parse(options.descriptor);
  const { handler } = options;
  if (typeof handler !== 'function') throw new TypeError('Service ingress requires a handler function');
  // The node's agent refuses a call whose timeoutMs exceeds its operation's budget, so no live call
  // outlasts the largest budget the descriptor declares (a stream's lifetime counts as its budget); an
  // envelope that has not been read by then belongs to no call, which makes it the default read deadline.
  const bodyTimeoutMs =
    options.bodyTimeoutMs === undefined
      ? Math.max(...descriptor.operations.map(serviceOperationTimeout))
      : BodyTimeoutSchema.parse(options.bodyTimeoutMs);
  const operations = new Map(descriptor.operations.map((operation) => [operation.id, operation]));
  // The envelope is read before any field is trusted, so its ceiling is the widest the descriptor declares.
  const envelopeBytes = jsonEnvelopeBytes(
    Math.max(...descriptor.operations.map((operation) => operation.limits.requestBytes)),
  );
  return async (request) => {
    if (request.method !== 'POST') return refusal('service requests are POST envelopes');
    if (declaredLengthExceeds(request.headers, envelopeBytes))
      return refusal('service envelope exceeds the descriptor request limit');
    // The deadline gets an abort of its own so that it ends the read and nothing else: the forwarded
    // request keeps the node's signal, so a handler or a stream is never cut by it. The reason's identity
    // tells the deadline from the caller going away.
    const expired = new Error('envelope read deadline');
    const reading = new AbortController();
    const timer = setTimeout(() => reading.abort(expired), bodyTimeoutMs);
    const callerGone = () => reading.abort(request.signal.reason);
    if (request.signal.aborted) callerGone();
    else request.signal.addEventListener('abort', callerGone, { once: true });
    let text: string;
    try {
      const bytes = await readBoundedBody(request.body, {
        maxBytes: envelopeBytes,
        signal: reading.signal,
        limitError: () => new RangeError('envelope limit'),
      });
      text = envelopeText.decode(bytes);
    } catch (error) {
      return refusal(
        error === expired
          ? 'service envelope was not read within its deadline'
          : error instanceof RangeError
            ? 'service envelope exceeds the descriptor request limit'
            : 'service envelope could not be read',
      );
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', callerGone);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return refusal('service envelope is not JSON');
    }
    const envelope = ServiceIngressSchema.safeParse(json);
    if (!envelope.success) return refusal('service envelope is not a version 1 ingress');
    const call = envelope.data;
    if (call.service !== descriptor.service) return refusal('service is not served here');
    if (call.revision !== descriptor.revision) return refusal('service revision is not served here');
    const operation = operations.get(call.operation);
    if (operation === undefined) return refusal('operation is not declared');
    if (Buffer.byteLength(call.payload) > operation.limits.requestBytes)
      return refusal('payload exceeds the operation request limit');
    const trace = TraceIdSchema.safeParse(request.headers.get(SERVICE_TRACE_HEADER));
    const forwarded = new Request(`http://owner.invalid${operation.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: call.payload,
      signal: request.signal,
    });
    delivered.attach(forwarded, {
      caller: call.caller,
      operation: call.operation,
      id: call.id,
      traceId: trace.success ? trace.data : call.id,
    });
    return handler(forwarded);
  };
}
