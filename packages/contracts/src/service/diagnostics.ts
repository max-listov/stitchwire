import { z } from 'zod';

/** The header that carries a call's trace id from the client through the door, the node and the owner's socket. */
export const SERVICE_TRACE_HEADER = 'x-stitchwire-trace-id';

/** Observed causes, never inferred from a coincident timestamp or arbitrary AbortSignal reason. */
export const ServiceCancellationOriginSchema = z.enum([
  'caller-abort',
  'caller-deadline',
  'door-disconnect',
  'door-deadline',
  'broker-deadline',
  'caller-disconnect',
  'target-disconnect',
  'lane-disconnect',
  'agent-shutdown',
  'broker-shutdown',
  'executor-deadline',
]);
export type ServiceCancellationOrigin = z.infer<typeof ServiceCancellationOriginSchema>;
export const CallerServiceCancellationSchema = ServiceCancellationOriginSchema.extract([
  'caller-abort',
  'caller-deadline',
  'door-disconnect',
  'door-deadline',
  'agent-shutdown',
]);
export const ServicePhaseSchema = z.strictObject({
  phase: z.enum([
    'target-received',
    'descriptor-start',
    'descriptor-end',
    'admitted',
    'endpoint-start',
    'endpoint-end',
    'http-start',
    'http-headers',
    'body-start',
    'body-end',
    'terminal',
  ]),
  elapsedMs: z.number().nonnegative(),
});
export type ServicePhase = z.infer<typeof ServicePhaseSchema>;
export const ServiceDiagnosticsSchema = z.strictObject({
  traceId: z.uuid(),
  requestId: z.uuid(),
  phases: z.array(ServicePhaseSchema).max(16),
});
export type ServiceDiagnostics = z.infer<typeof ServiceDiagnosticsSchema>;

export const ServiceClientTraceSchema = z.strictObject({
  phase: z.enum(['start', 'result']),
  traceId: z.uuid(),
  diagnostics: ServiceDiagnosticsSchema.optional(),
  cancellationOrigin: ServiceCancellationOriginSchema.optional(),
});
export type ServiceClientTrace = z.infer<typeof ServiceClientTraceSchema>;
