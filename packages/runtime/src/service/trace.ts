import { z } from 'zod';
import {
  ServiceCancellationOriginSchema,
  ServicePhaseSchema,
  type ServicePhase,
} from '../../../contracts/src/service/diagnostics.ts';
import {
  ServiceIdSchema,
  ServiceOperationIdSchema,
  type ServiceOutcome,
  type ServiceRoute,
} from '../../../contracts/src/service/contracts.ts';
import { NodeIdSchema } from '../../../contracts/src/protocol/identity.ts';
import type { Audit } from '../broker/audit.ts';

export const ServiceTraceSchema = z.strictObject({
  kind: z.literal('service-phase'),
  node: NodeIdSchema,
  traceId: z.uuid(),
  requestId: z.uuid().optional(),
  target: NodeIdSchema.optional(),
  service: ServiceIdSchema.optional(),
  operation: ServiceOperationIdSchema.optional(),
  phase: z.enum([
    'door-entry',
    'door-parsed',
    'door-terminal',
    'door-result',
    'lane-dispatch',
    'lane-result',
    ...ServicePhaseSchema.shape.phase.options,
  ]),
  elapsedMs: z.number().nonnegative(),
  outcome: z.string().max(32).optional(),
  cancellationOrigin: ServiceCancellationOriginSchema.optional(),
});
type ServiceTrace = z.infer<typeof ServiceTraceSchema>;
export type TraceService = (
  call: { traceId?: string; id?: string; to?: string; service?: string; operation?: string },
  phase: ServiceTrace['phase'],
  elapsedMs: number,
  outcome?: ServiceOutcome,
) => void;

/** No spreads from calls, outcomes or headers: only fixed metadata crosses the journal boundary. */
export function serviceTrace(audit: Audit, node: string): TraceService {
  return (call, phase, elapsedMs, outcome) => {
    if (call.traceId === undefined) return;
    audit.write({
      kind: 'service-phase',
      node,
      traceId: call.traceId,
      ...(call.id === undefined ? {} : { requestId: call.id }),
      ...(call.to === undefined ? {} : { target: call.to }),
      ...(call.service === undefined ? {} : { service: call.service }),
      ...(call.operation === undefined ? {} : { operation: call.operation }),
      phase,
      elapsedMs,
      ...(outcome === undefined ? {} : { outcome: outcome.status === 'failure' ? outcome.code : 'received' }),
      ...(outcome?.status === 'failure' && outcome.cancellationOrigin !== undefined
        ? { cancellationOrigin: outcome.cancellationOrigin }
        : {}),
    });
  };
}

/** One bounded array per admitted unary invocation, released with the invocation. */
export class TargetServiceTrace {
  private readonly start = performance.now();
  private readonly phases: ServicePhase[] = [];
  constructor(
    private readonly call: ServiceRoute,
    private readonly write?: TraceService,
  ) {}
  mark(phase: ServicePhase['phase'], outcome?: ServiceOutcome): void {
    const elapsedMs = performance.now() - this.start;
    if (this.phases.length < 16) this.phases.push({ phase, elapsedMs });
    this.write?.(this.call, phase, elapsedMs, outcome);
  }
  finish(outcome: ServiceOutcome): ServiceOutcome {
    this.mark('terminal', outcome);
    return {
      ...outcome,
      diagnostics: {
        traceId: this.call.traceId ?? this.call.id,
        requestId: this.call.id,
        phases: [...this.phases],
      },
    };
  }
}
