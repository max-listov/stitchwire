import { z } from 'zod';
import { LocalVersionSchema } from '../door/common.ts';
import { NodeIdSchema } from '../protocol/identity.ts';
import { utf8ByteLength } from '../protocol/payload.ts';
import { SERVICE_MAX_REQUEST_BYTES } from './request-bounds.ts';
import {
  ServiceCancellationOriginSchema,
  ServiceDiagnosticsSchema,
  type ServiceCancellationOrigin,
} from './diagnostics.ts';
import {
  type Refusal,
  RefusalSchema,
  TRANSPORT_CAUSES,
  type TransportCause,
  TransportCauseSchema,
  RetryAfterSchema,
} from '../protocol/failure.ts';

export const SERVICE_MAX_RESPONSE_BYTES = 1_048_576;
export const SERVICE_MAX_ENVELOPE_BYTES = 8_388_608;
export const SERVICE_MAX_TIMEOUT_MS = 30_000;
export const SERVICE_MAX_INFLIGHT = 32;
/**
 * The largest descriptor file a node reads, and the only bound on how many operations a descriptor
 * holds. An operation projected from an owner contract takes a few hundred bytes, so this admits
 * about a thousand of them; a bigger file is a wrong path or a runaway writer, and is refused on
 * every call before more than one byte past this limit is read.
 */
export const SERVICE_MAX_DESCRIPTOR_BYTES = 262_144;

export const ServiceIdSchema = z
  .string()
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const ServiceOperationIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const ServiceRevisionSchema = z
  .string()
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);

function jsonText(maxBytes: number) {
  return z
    .string()
    .max(maxBytes)
    .superRefine((text, ctx) => {
      if (utf8ByteLength(text) > maxBytes) {
        ctx.addIssue({ code: 'custom', message: `JSON payload exceeds ${maxBytes} UTF-8 bytes` });
        return;
      }
      try {
        JSON.parse(text);
      } catch {
        ctx.addIssue({ code: 'custom', message: 'payload must be one JSON document' });
      }
    });
}
export const ServiceRequestPayloadSchema = jsonText(SERVICE_MAX_REQUEST_BYTES);
export const ServiceResponsePayloadSchema = jsonText(SERVICE_MAX_RESPONSE_BYTES);
export const ServiceCallSchema = z.strictObject({
  traceId: z.uuid().optional(),
  to: NodeIdSchema,
  service: ServiceIdSchema,
  revision: ServiceRevisionSchema,
  operation: ServiceOperationIdSchema,
  payload: ServiceRequestPayloadSchema,
  timeoutMs: z.number().int().min(1).max(SERVICE_MAX_TIMEOUT_MS),
});
export type ServiceCall = z.infer<typeof ServiceCallSchema>;

export const ServiceRouteSchema = ServiceCallSchema.extend({
  id: z.uuid(),
  from: NodeIdSchema,
});
export type ServiceRoute = z.infer<typeof ServiceRouteSchema>;

// Payload remains a separate string: it cannot overwrite authenticated envelope fields.
// Strict, bounded ASCII metadata plus a byte-bounded payload fit the Unix envelope budget.
export const ServiceIngressSchema = z.strictObject({
  v: z.literal(1),
  id: z.uuid(),
  caller: NodeIdSchema,
  service: ServiceIdSchema,
  revision: ServiceRevisionSchema,
  operation: ServiceOperationIdSchema,
  payload: ServiceRequestPayloadSchema,
});
export type ServiceIngress = z.infer<typeof ServiceIngressSchema>;

export const ServiceFailureCodeSchema = z.enum([
  'denied',
  'unsupported',
  'capacity',
  'invalid-request',
  'offline',
  'timeout',
  'cancelled',
  'unavailable',
  'invalid-response',
]);
export type ServiceFailureCode = z.infer<typeof ServiceFailureCodeSchema>;
export const ServiceFailureOutcomeSchema = z
  .strictObject({
    status: z.literal('failure'),
    code: ServiceFailureCodeSchema,
    delivery: z.enum(['not-dispatched', 'unknown']),
    retryAfterMs: RetryAfterSchema,
    refusal: RefusalSchema,
    detail: z.string().max(4_096).optional(),
    transportCause: TransportCauseSchema.nullable(),
    cancellationOrigin: ServiceCancellationOriginSchema.optional(),
    diagnostics: ServiceDiagnosticsSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const transport = value.transportCause === null ? undefined : TRANSPORT_CAUSES[value.transportCause];
    if (transport !== undefined && value.code !== transport.serviceCode)
      ctx.addIssue({
        code: 'custom',
        path: ['code'],
        message: `${value.transportCause} requires code "${transport.serviceCode}"`,
      });
    if (transport !== undefined && value.delivery !== transport.delivery)
      ctx.addIssue({
        code: 'custom',
        path: ['delivery'],
        message: `${value.transportCause} requires delivery "${transport.delivery}"`,
      });
    const refusalCode: Record<Exclude<Refusal, 'none'>, z.infer<typeof ServiceFailureCodeSchema>> = {
      policy: 'denied',
      capacity: 'capacity',
      request: 'invalid-request',
    };
    if (value.refusal !== 'none' && value.code !== refusalCode[value.refusal])
      ctx.addIssue({
        code: 'custom',
        path: ['refusal'],
        message: `${value.refusal} refusal requires code "${refusalCode[value.refusal]}"`,
      });
    if (value.retryAfterMs !== null && value.refusal !== 'capacity')
      ctx.addIssue({
        code: 'custom',
        path: ['retryAfterMs'],
        message: 'retryAfterMs requires capacity refusal',
      });
  });
export const ServiceOutcomeSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('response'),
    delivery: z.literal('received'),
    httpStatus: z
      .number()
      .int()
      .min(200)
      .max(599)
      .refine((code) => code < 300 || code >= 400),
    payload: ServiceResponsePayloadSchema,
    diagnostics: ServiceDiagnosticsSchema.optional(),
  }),
  ServiceFailureOutcomeSchema,
]);
export type ServiceOutcome = z.infer<typeof ServiceOutcomeSchema>;
// The field bounds imply the envelope ceiling without serializing the document during validation.
export const ServiceResultSchema = z.strictObject({
  id: z.uuid(),
  from: NodeIdSchema,
  outcome: ServiceOutcomeSchema,
});

export const ServiceCancelSchema = z.strictObject({
  id: z.uuid(),
  to: NodeIdSchema,
  origin: ServiceCancellationOriginSchema,
});
export type ServiceResult = z.infer<typeof ServiceResultSchema>;
export const LocalServiceResultSchema = z.strictObject({
  v: LocalVersionSchema,
  outcome: ServiceOutcomeSchema,
  traceId: z.uuid().optional(),
});
export function serviceFailure(
  code: z.infer<typeof ServiceFailureCodeSchema>,
  delivery: 'not-dispatched' | 'unknown' = 'not-dispatched',
  transportCause: TransportCause | null = null,
  refusal: Refusal = code === 'capacity'
    ? 'capacity'
    : code === 'denied'
      ? 'policy'
      : code === 'invalid-request'
        ? 'request'
        : 'none',
  detail?: string,
  cancellationOrigin?: ServiceCancellationOrigin,
): ServiceOutcome {
  return ServiceFailureOutcomeSchema.parse({
    status: 'failure',
    code,
    delivery,
    retryAfterMs: null,
    transportCause,
    refusal,
    ...(detail === undefined ? {} : { detail }),
    ...(cancellationOrigin === undefined ? {} : { cancellationOrigin }),
  });
}
