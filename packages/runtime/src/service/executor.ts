import { sortedDeep } from '../json.ts';
import { wireLogger } from '../logger.ts';
import { lstat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { socketIdentity } from '../config/identity.ts';
import { createBoundedAdmission, type BoundedOperationLease } from 'stitchkit/application';
import { createUnixClientTransport, UnixClientTransportError } from 'stitchkit/server';
import {
  SERVICE_MAX_INFLIGHT,
  type ServiceOutcome,
  ServiceOutcomeSchema,
  type ServiceRoute,
  serviceFailure,
} from '../../../contracts/src/service/contracts.ts';
import { SERVICE_TRACE_HEADER } from '../../../contracts/src/service/diagnostics.ts';
import type { ServicePolicy } from '../../../contracts/src/service/policy-schema.ts';
import { jsonEnvelopeBytes } from '../../../contracts/src/protocol/json-bounds.ts';
import { SocketCeiling } from './socket-ceiling.ts';
import { ServiceDescriptorStore } from './descriptor-store.ts';
import { ServiceDispatchBudget } from './dispatch-budget.ts';
import { resolveService, type ServiceResolution } from './policy.ts';
import { TargetServiceTrace, type TraceService } from './trace.ts';
import { serviceAbortOrigin } from './cancellation.ts';

type UnixEndpointStat = {
  uid: number;
  gid: number;
  mode: number;
  isSocket(): boolean;
  isDirectory(): boolean;
};

export function isPrivateUnixEndpoint(
  socket: UnixEndpointStat,
  directory: UnixEndpointStat,
  identity = { uid: process.getuid?.(), gid: process.getgid?.() },
): boolean {
  return (
    identity.uid !== undefined &&
    identity.gid !== undefined &&
    socket.isSocket() &&
    directory.isDirectory() &&
    socket.uid === identity.uid &&
    directory.uid === identity.uid &&
    ((socket.mode & 0o070) === 0 || socket.gid === identity.gid) &&
    ((directory.mode & 0o070) === 0 || directory.gid === identity.gid) &&
    (socket.mode & 0o007) === 0 &&
    (directory.mode & 0o007) === 0
  );
}

type AcceptedResolution = Extract<ServiceResolution, { accepted: true }>;
export type ServiceDispatch =
  | { accepted: false; outcome: ServiceOutcome }
  | {
      accepted: true;
      response: Response;
      resolved: AcceptedResolution;
      timedOut(): boolean;
      close(): Promise<void>;
    };

function policyFingerprint(policy: ServicePolicy): string {
  // The constructor may receive a larger node-services object. Only executor-owned policy
  // fields define an edition; descriptor path lists/namespaces are another owner's metadata.
  return JSON.stringify(sortedDeep({ bindings: policy.bindings, grants: policy.grants }));
}

/** One process-wide executor shared by unary calls and service-stream producer adapters. */
export class ServiceExecutor {
  private readonly shutdown = new AbortController();
  private readonly active = new Set<Promise<ServiceOutcome>>();
  private policyEdition = 0;
  private policyFingerprint: string;
  private readonly sockets = new SocketCeiling();
  /**
   * The identity of each bound socket path, resolved once per policy edition: the path walk is not
   * per call. A socket directory re-pointed under a running policy keeps the identity it had until
   * the next policy; calls still connect by the path, only the count of the ceiling is that old.
   */
  private readonly socketKeys = new Map<string, string>();
  private readonly admission = createBoundedAdmission({
    policy: { global: { maxConcurrent: SERVICE_MAX_INFLIGHT } },
  });

  constructor(
    private policy: ServicePolicy,
    private readonly nodeId: string,
    readonly descriptors = new ServiceDescriptorStore(),
    private readonly trace?: TraceService,
  ) {
    this.policyFingerprint = policyFingerprint(policy);
  }

  /** Serve by these bindings and grants from the next call on: owners declare services while it runs. */
  usePolicy(policy: ServicePolicy): void {
    const fingerprint = policyFingerprint(policy);
    // Startup declaration refresh can reproduce the running tables while the first call loads
    // its descriptor. Only a real policy replacement invalidates that in-flight preflight.
    if (fingerprint === this.policyFingerprint) return;
    this.policyFingerprint = fingerprint;
    this.policy = policy;
    this.socketKeys.clear();
    this.policyEdition++;
  }

  execute(call: ServiceRoute, signal: AbortSignal): Promise<ServiceOutcome> {
    const trace = new TargetServiceTrace(call, this.trace);
    trace.mark('target-received');
    const pending = this.executeUnary(call, AbortSignal.any([signal, this.shutdown.signal]), trace)
      .then((outcome) => trace.finish(outcome))
      .finally(() => this.active.delete(pending));
    this.active.add(pending);
    return pending;
  }

  async drain(): Promise<void> {
    this.admission.stopAdmission();
    this.shutdown.abort('agent-shutdown');
    await Promise.allSettled([...this.active]);
  }

  private async executeUnary(
    call: ServiceRoute,
    signal: AbortSignal,
    trace: TargetServiceTrace,
  ): Promise<ServiceOutcome> {
    const dispatched = await this.dispatch(call, signal, 'unary', trace);
    if (!dispatched.accepted) return dispatched.outcome;
    try {
      trace.mark('body-start');
      const bytes = await dispatched.response.arrayBuffer();
      trace.mark('body-end');
      const payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const parsed = ServiceOutcomeSchema.safeParse({
        status: 'response',
        delivery: 'received',
        httpStatus: dispatched.response.status,
        payload,
      });
      return parsed.success ? parsed.data : serviceFailure('invalid-response', 'unknown');
    } catch (error) {
      if (!signal.aborted && !dispatched.timedOut())
        wireLogger.error('[wire:service] owner response failed', {
          service: call.service,
          id: call.id,
          error,
        });
      return serviceFailure(
        dispatched.timedOut() ? 'timeout' : signal.aborted ? 'cancelled' : 'invalid-response',
        'unknown',
        null,
        'none',
        undefined,
        dispatched.timedOut() ? 'executor-deadline' : signal.aborted ? serviceAbortOrigin(signal) : undefined,
      );
    } finally {
      await dispatched.close();
    }
  }

  openStream(call: ServiceRoute, signal: AbortSignal): Promise<ServiceDispatch> {
    return this.dispatch(call, signal, 'stream');
  }

  private async dispatch(
    call: ServiceRoute,
    signal: AbortSignal,
    responseKind: 'unary' | 'stream',
    trace?: TargetServiceTrace,
  ): Promise<ServiceDispatch> {
    if (signal.aborted)
      return {
        accepted: false,
        outcome: serviceFailure(
          'cancelled',
          'not-dispatched',
          null,
          'none',
          undefined,
          serviceAbortOrigin(signal),
        ),
      };
    const policy = this.policy;
    const edition = this.policyEdition;
    const binding = policy.bindings.find((entry) => entry.service === call.service);
    if (!binding) return { accepted: false, outcome: serviceFailure('unsupported') };
    const budget = new ServiceDispatchBudget(
      signal,
      responseKind === 'stream' ? binding.limits.timeoutMs : call.timeoutMs,
    );
    const controller = budget.controller;
    let lease: BoundedOperationLease | undefined;
    let transport: ReturnType<typeof createUnixClientTransport> | undefined;
    let dispatched = false;
    let handedOff = false;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      budget.close();
      try {
        await transport?.close();
      } finally {
        lease?.release();
      }
    };
    try {
      trace?.mark('descriptor-start');
      const loaded = await budget.wait(this.descriptors.load(binding, controller.signal));
      trace?.mark('descriptor-end');
      controller.signal.throwIfAborted();
      if (loaded.state !== 'loaded') {
        wireLogger.error('[wire:service] owner descriptor unavailable', {
          service: call.service,
          state: loaded.state,
          detail: loaded.detail,
        });
        return {
          accepted: false,
          outcome: serviceFailure(loaded.state === 'invalid' ? 'invalid-response' : 'unavailable'),
        };
      }
      if (edition !== this.policyEdition) return { accepted: false, outcome: serviceFailure('unavailable') };
      const resolved = resolveService(policy, this.nodeId, call, loaded.descriptor);
      if (!resolved.accepted) return { accepted: false, outcome: serviceFailure(resolved.code) };
      if (resolved.operation.response.kind !== responseKind)
        return { accepted: false, outcome: serviceFailure('invalid-request') };
      const openingTimeoutMs =
        responseKind === 'stream'
          ? Math.min(resolved.binding.limits.timeoutMs, resolved.operation.limits.timeoutMs)
          : call.timeoutMs;
      budget.opening(openingTimeoutMs);
      controller.signal.throwIfAborted();
      // Descriptor editions and limits may change while earlier operations still hold capacity.
      // The owner socket is the resource; the current ceiling applies to every new acquisition.
      const { socketPath } = resolved.binding;
      const budgetKey = this.socketKeys.get(socketPath) ?? socketIdentity(socketPath);
      this.socketKeys.set(socketPath, budgetKey);
      const freeSocket = this.sockets.acquire(budgetKey, resolved.limits.maxInflight);
      if (freeSocket === null) return { accepted: false, outcome: serviceFailure('capacity') };
      const admitted = this.admission.acquire();
      if (admitted.outcome === 'refused') {
        freeSocket();
        return { accepted: false, outcome: serviceFailure('capacity') };
      }
      let released = false;
      lease = {
        get released() {
          return released;
        },
        release: () => {
          if (released) return;
          released = true;
          freeSocket();
          admitted.lease.release();
        },
      };
      trace?.mark('admitted');
      trace?.mark('endpoint-start');
      const [socket, directory] = await budget.wait(
        Promise.all([lstat(resolved.binding.socketPath), lstat(dirname(resolved.binding.socketPath))]),
      );
      budget.opening(openingTimeoutMs);
      controller.signal.throwIfAborted();
      if (edition !== this.policyEdition) return { accepted: false, outcome: serviceFailure('unavailable') };
      if (!isPrivateUnixEndpoint(socket, directory)) {
        await close();
        return { accepted: false, outcome: serviceFailure('denied') };
      }
      trace?.mark('endpoint-end');
      const common = {
        socketPath: resolved.binding.socketPath,
        maxConnections: 1,
        maxRequestBytes: jsonEnvelopeBytes(resolved.limits.requestBytes),
        maxHeaderBytes: 8192,
        headersTimeoutMs: openingTimeoutMs,
        maxRedirects: 0,
      };
      transport =
        responseKind === 'stream'
          ? createUnixClientTransport({ ...common, responseBodyMode: 'streaming' })
          : createUnixClientTransport({ ...common, maxResponseBytes: resolved.limits.responseBytes });
      dispatched = true;
      trace?.mark('http-start');
      const response = await transport.fetch(`http://owner.invalid${resolved.binding.endpointPath}`, {
        method: 'POST',
        body: JSON.stringify(resolved.ingress),
        headers: { 'content-type': 'application/json', [SERVICE_TRACE_HEADER]: call.traceId ?? call.id },
        redirect: 'error',
        signal: controller.signal,
      });
      trace?.mark('http-headers');
      budget.opening(openingTimeoutMs);
      controller.signal.throwIfAborted();
      if (responseKind === 'stream') {
        budget.lifetime(resolved.limits.timeoutMs);
      }
      controller.signal.throwIfAborted();
      handedOff = true;
      return { accepted: true, response, resolved, timedOut: () => budget.timedOut, close };
    } catch (error) {
      if (!signal.aborted && !budget.timedOut)
        wireLogger.error('[wire:service] owner I/O failed', { service: call.service, id: call.id, error });
      const delivery =
        error instanceof UnixClientTransportError && error.delivery === 'not-dispatched'
          ? 'not-dispatched'
          : dispatched
            ? 'unknown'
            : 'not-dispatched';
      await close();
      return {
        accepted: false,
        outcome: serviceFailure(
          budget.timedOut
            ? 'timeout'
            : signal.aborted
              ? 'cancelled'
              : error instanceof UnixClientTransportError && error.code === 'UNIX_RESPONSE_TOO_LARGE'
                ? 'invalid-response'
                : 'unavailable',
          delivery,
          null,
          'none',
          undefined,
          budget.timedOut ? 'executor-deadline' : signal.aborted ? serviceAbortOrigin(signal) : undefined,
        ),
      };
    } finally {
      if (!handedOff) await close();
    }
  }
}
