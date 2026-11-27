import { utf8ByteLength } from '../../../contracts/src/protocol/payload.ts';
import type { ServiceIngress, ServiceRoute } from '../../../contracts/src/service/contracts.ts';
import { serviceOperationTimeout } from '../../../contracts/src/service/budgets.ts';
import type {
  ServiceBinding,
  ServiceDescriptor,
  ServiceGrant,
  ServicePolicy,
} from '../../../contracts/src/service/policy-schema.ts';

/** The grants that name this caller, this target and this service: all that can admit the call. */
function grantsOf(grants: readonly ServiceGrant[], call: ServiceRoute): ServiceGrant[] {
  return grants.filter(
    (grant) => grant.caller === call.from && grant.target === call.to && grant.service === call.service,
  );
}

/** The broker knows exact operation grants but does not receive local socket paths or domain DTOs. */
export function authorizeServiceRoute(
  grants: readonly ServiceGrant[],
  call: ServiceRoute,
): ServiceRoute | null {
  const admitted = grantsOf(grants, call).some(
    (grant) => grant.scope.kind === 'service-read' || grant.scope.operation === call.operation,
  );
  return admitted ? call : null;
}

export type ServiceResolution =
  | { accepted: false; code: 'denied' | 'unsupported' | 'invalid-request' }
  | {
      accepted: true;
      binding: ServiceBinding;
      operation: ServiceDescriptor['operations'][number];
      effect: string;
      limits: { requestBytes: number; responseBytes: number; timeoutMs: number; maxInflight: number };
      ingress: ServiceIngress;
    };

/** Call and policy are parsed at ingress/config boundaries. This resolver has no I/O, timers,
 * admission leases or fallback; it cannot grant execution merely by recognizing a service. */
export function resolveService(
  policy: ServicePolicy,
  nodeId: string,
  call: ServiceRoute,
  descriptor: ServiceDescriptor,
): ServiceResolution {
  if (call.to !== nodeId) return { accepted: false, code: 'denied' };
  const binding = policy.bindings.find((item) => item.service === call.service);
  if (!binding || descriptor.service !== binding.service || descriptor.revision !== call.revision)
    return { accepted: false, code: 'unsupported' };
  const operation = descriptor.operations.find((item) => item.id === call.operation);
  if (!operation) return { accepted: false, code: 'unsupported' };
  const matching = grantsOf(policy.grants, call);
  const exact = matching.some(
    (grant) => grant.scope.kind === 'operation' && grant.scope.operation === call.operation,
  );
  const serviceRead = matching.some((grant) => grant.scope.kind === 'service-read');
  if (!exact && !(serviceRead && operation.effect === 'read')) return { accepted: false, code: 'denied' };
  const limits = {
    requestBytes: Math.min(binding.limits.requestBytes, operation.limits.requestBytes),
    responseBytes: Math.min(binding.limits.responseBytes, operation.limits.responseBytes),
    timeoutMs: Math.min(binding.limits.timeoutMs, serviceOperationTimeout(operation)),
    maxInflight: Math.min(binding.maxInflight, descriptor.maxInflight),
  };
  if (call.timeoutMs > limits.timeoutMs || utf8ByteLength(call.payload) > limits.requestBytes)
    return { accepted: false, code: 'invalid-request' };
  return {
    accepted: true,
    binding,
    operation,
    effect: operation.effect,
    limits: { ...limits, timeoutMs: call.timeoutMs },
    ingress: {
      v: 1,
      id: call.id,
      caller: call.from,
      service: call.service,
      revision: call.revision,
      operation: call.operation,
      payload: call.payload,
    },
  };
}
