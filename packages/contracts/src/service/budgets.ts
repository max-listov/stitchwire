import type { ServiceDescriptor } from './policy-schema.ts';

/** Unary request duration or stream lifetime after response headers. */
export function serviceOperationTimeout(operation: ServiceDescriptor['operations'][number]): number {
  return operation.response.kind === 'stream'
    ? (operation.response.lifetimeMs ?? operation.limits.timeoutMs)
    : operation.limits.timeoutMs;
}
