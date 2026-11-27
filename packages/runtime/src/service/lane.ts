import { wireLogger } from '../logger.ts';
import { createBoundedAdmission } from 'stitchkit/application';
import {
  SERVICE_MAX_INFLIGHT,
  type ServiceCall,
  type ServiceOutcome,
  type ServiceResult,
  type ServiceRoute,
  serviceFailure,
} from '../../../contracts/src/service/contracts.ts';
import type { ServiceExecutor } from './executor.ts';
import { serviceAbortOrigin } from './cancellation.ts';
import type { ServiceCancellationOrigin } from '../../../contracts/src/service/diagnostics.ts';
import type { TraceService } from './trace.ts';

/** Correlation belongs to a single authenticated lane; disconnect never replays work. */
export class ServiceLane {
  private readonly pending = new Map<string, { to: string; settle(outcome: ServiceOutcome): void }>();
  private readonly executing = new Map<string, AbortController>();
  private readonly admission = createBoundedAdmission({
    policy: { global: { maxConcurrent: SERVICE_MAX_INFLIGHT } },
  });
  constructor(
    private readonly node: string,
    private readonly executor: ServiceExecutor,
    private readonly io: {
      call(request: ServiceRoute): boolean;
      cancel(id: string, to: string, origin: ServiceCancellationOrigin): void;
      result(result: ServiceResult): void;
    },
    private readonly trace?: TraceService,
  ) {}

  call(input: ServiceCall, signal?: AbortSignal): Promise<ServiceOutcome> {
    if (signal?.aborted)
      return Promise.resolve(
        serviceFailure('cancelled', 'not-dispatched', null, 'none', undefined, serviceAbortOrigin(signal)),
      );
    const lease = this.admission.acquire();
    if (lease.outcome === 'refused') return Promise.resolve(serviceFailure('capacity'));
    const id = crypto.randomUUID();
    const started = performance.now();
    const route = { ...input, id, from: this.node };
    return new Promise((resolve) => {
      let sent = false;
      const settle = (outcome: ServiceOutcome) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        lease.lease.release();
        this.trace?.(route, 'lane-result', performance.now() - started, outcome);
        resolve(outcome);
      };
      const cancel = (code: 'cancelled' | 'timeout') => {
        if (!this.pending.has(id)) return;
        const origin = code === 'timeout' ? 'caller-deadline' : serviceAbortOrigin(signal);
        if (sent) this.io.cancel(id, input.to, origin);
        settle(serviceFailure(code, sent ? 'unknown' : 'not-dispatched', null, 'none', undefined, origin));
      };
      const abort = () => cancel('cancelled');
      const timer = setTimeout(() => cancel('timeout'), input.timeoutMs);
      this.pending.set(id, { to: input.to, settle });
      signal?.addEventListener('abort', abort, { once: true });
      this.trace?.(route, 'lane-dispatch', performance.now() - started);
      sent = this.io.call(route);
      if (!sent) settle(serviceFailure('unavailable', 'not-dispatched', 'no-connected-lane'));
    });
  }
  result(result: ServiceResult): void {
    const pending = this.pending.get(result.id);
    if (pending?.to === result.from) pending.settle(result.outcome);
  }
  invoke(call: ServiceRoute): void {
    if (this.executing.has(call.id)) return;
    if (this.executing.size >= SERVICE_MAX_INFLIGHT) {
      this.io.result({ id: call.id, from: this.node, outcome: serviceFailure('capacity') });
      return;
    }
    const controller = new AbortController();
    this.executing.set(call.id, controller);
    void this.executor
      .execute(call, controller.signal)
      .then(
        (outcome) => {
          if (!controller.signal.aborted) this.io.result({ id: call.id, from: this.node, outcome });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          wireLogger.error('[wire:service] executor failed', { id: call.id, error });
          this.io.result({ id: call.id, from: this.node, outcome: serviceFailure('unavailable', 'unknown') });
        },
      )
      .finally(() => this.executing.delete(call.id));
  }
  cancel(id: string, origin: ServiceCancellationOrigin): void {
    this.executing.get(id)?.abort(origin);
  }
  disconnect(origin: ServiceCancellationOrigin = 'lane-disconnect'): void {
    for (const entry of this.pending.values())
      entry.settle(
        serviceFailure('unavailable', 'unknown', 'lane-lost-after-dispatch', 'none', undefined, origin),
      );
    for (const controller of this.executing.values()) controller.abort(origin);
  }
}
