import { createBoundedAdmission } from 'stitchkit/application';
import type { TransportCause } from '../../../contracts/src/protocol/failure.ts';
import {
  SERVICE_MAX_INFLIGHT,
  type ServiceResult,
  type ServiceRoute,
  serviceFailure,
} from '../../../contracts/src/service/contracts.ts';
import type { ServiceGrant } from '../../../contracts/src/service/policy-schema.ts';
import type { ServiceAudit, ServiceAuditFacts } from './audit-schema.ts';
import { authorizeServiceRoute } from './policy.ts';
import {
  CallerServiceCancellationSchema,
  type ServiceCancellationOrigin,
} from '../../../contracts/src/service/diagnostics.ts';

interface Pending {
  caller: string;
  target: string;
  call: ServiceRoute;
  settle(result: ServiceResult): void;
}
/** Where a service router's calls, results and cancellations go, and where its journal entries are written. */
export interface ServiceSink {
  target(node: string): string | undefined;
  invoke(socket: string, call: ServiceRoute): void;
  result(socket: string, result: ServiceResult): void;
  cancel(socket: string, id: string, to: string, origin: ServiceCancellationOrigin): void;
  audit(
    call: ServiceRoute,
    phase: ServiceAudit['phase'],
    outcome: ServiceAudit['outcome'],
    facts: ServiceAuditFacts,
  ): void;
}

export class ServiceRouter {
  private readonly pending = new Map<string, Pending>();
  private readonly admission = createBoundedAdmission({
    policy: {
      global: { maxConcurrent: SERVICE_MAX_INFLIGHT },
      perKey: { maxConcurrent: 8, maxKeys: SERVICE_MAX_INFLIGHT },
    },
  });
  constructor(
    /** Read on every call: nodes declare grants for their owners' services while the broker runs. */
    private readonly grants: () => readonly ServiceGrant[],
    private readonly io: ServiceSink,
  ) {}
  call(caller: string, node: string, input: ServiceRoute): void {
    const started = performance.now();
    const facts = (
      responseBytes: number | null,
      delivery: ServiceAudit['delivery'],
      transportCause: TransportCause | null = null,
    ) => ({
      ms: performance.now() - started,
      requestBytes: Buffer.byteLength(input.payload),
      responseBytes,
      delivery,
      transportCause,
    });
    const reject = (
      code: Parameters<typeof serviceFailure>[0],
      transportCause: Parameters<typeof serviceFailure>[2] = null,
      cancellationOrigin?: ServiceCancellationOrigin,
    ) => {
      this.io.audit({ ...input, from: node }, 'result', code, {
        ...facts(null, 'not-dispatched', transportCause),
        ...(cancellationOrigin === undefined ? {} : { cancellationOrigin }),
      });
      this.io.result(caller, {
        id: input.id,
        from: input.to,
        outcome: serviceFailure(
          code,
          'not-dispatched',
          transportCause,
          undefined,
          undefined,
          cancellationOrigin,
        ),
      });
    };
    if (input.from !== node || this.pending.has(input.id)) {
      reject('denied');
      return;
    }
    const call = authorizeServiceRoute(this.grants(), input);
    if (!call) {
      reject('denied');
      return;
    }
    const target = this.io.target(call.to);
    if (!target) {
      reject('offline', 'target-offline');
      return;
    }
    const admitted = this.admission.acquire(node);
    if (admitted.outcome === 'refused') {
      reject('capacity');
      return;
    }
    const timeoutMs = Math.floor(call.timeoutMs - (performance.now() - started));
    if (timeoutMs <= 0) {
      admitted.lease.release();
      reject('timeout', null, 'broker-deadline');
      return;
    }
    const settle = (result: ServiceResult) => {
      if (!this.pending.delete(call.id)) return;
      clearTimeout(timer);
      admitted.lease.release();
      this.io.audit(call, 'result', result.outcome.status === 'failure' ? result.outcome.code : 'received', {
        ...facts(
          result.outcome.status === 'failure' ? null : Buffer.byteLength(result.outcome.payload),
          result.outcome.status === 'failure' ? result.outcome.delivery : 'delivered',
          result.outcome.status === 'failure' ? (result.outcome.transportCause ?? null) : null,
        ),
        ...(result.outcome.status === 'failure' && result.outcome.cancellationOrigin !== undefined
          ? { cancellationOrigin: result.outcome.cancellationOrigin }
          : {}),
      });
      this.io.result(caller, result);
    };
    const timer = setTimeout(() => {
      this.io.cancel(target, call.id, call.to, 'broker-deadline');
      settle({
        id: call.id,
        from: call.to,
        outcome: serviceFailure('timeout', 'unknown', null, 'none', undefined, 'broker-deadline'),
      });
    }, timeoutMs);
    this.pending.set(call.id, { caller, target, call, settle });
    this.io.audit(call, 'dispatch', 'admitted', facts(null, null));
    this.io.invoke(target, { ...call, timeoutMs });
  }
  result(socket: string, result: ServiceResult): void {
    const entry = this.pending.get(result.id);
    if (entry?.target === socket && result.from === entry.call.to) entry.settle(result);
  }
  cancel(socket: string, id: string, origin: ServiceCancellationOrigin): void {
    if (!CallerServiceCancellationSchema.safeParse(origin).success) return;
    this.cancelPending(socket, id, origin);
  }
  private cancelPending(socket: string, id: string, origin: ServiceCancellationOrigin): void {
    const entry = this.pending.get(id);
    if (entry?.caller !== socket) return;
    this.io.cancel(entry.target, id, entry.call.to, origin);
    entry.settle({
      id,
      from: entry.call.to,
      outcome: serviceFailure('cancelled', 'unknown', null, 'none', undefined, origin),
    });
  }
  disconnect(socket: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.caller === socket) this.cancelPending(socket, id, 'caller-disconnect');
      else if (entry.target === socket)
        entry.settle({
          id,
          from: entry.call.to,
          outcome: serviceFailure(
            'unavailable',
            'unknown',
            'lane-lost-after-dispatch',
            'none',
            undefined,
            'target-disconnect',
          ),
        });
    }
  }
  stop(): void {
    this.admission.stopAdmission();
    for (const entry of this.pending.values())
      this.cancelPending(entry.caller, entry.call.id, 'broker-shutdown');
  }
}
