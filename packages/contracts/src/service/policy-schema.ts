import { z } from 'zod';
import { NodeIdSchema } from '../protocol/identity.ts';
import { AbsoluteFilePathSchema, UnixSocketPathSchema } from '../protocol/paths.ts';
import {
  SERVICE_MAX_INFLIGHT,
  SERVICE_MAX_RESPONSE_BYTES,
  SERVICE_MAX_TIMEOUT_MS,
  ServiceIdSchema,
  ServiceOperationIdSchema,
  ServiceRevisionSchema,
} from './contracts.ts';
import { OwnerRoutePathSchema } from './owner-route-path.ts';
import { SERVICE_MAX_REQUEST_BYTES } from './request-bounds.ts';

export const ServiceLimitsSchema = z.strictObject({
  requestBytes: z.number().int().min(1).max(SERVICE_MAX_REQUEST_BYTES),
  responseBytes: z.number().int().min(1).max(SERVICE_MAX_RESPONSE_BYTES),
  timeoutMs: z.number().int().min(1).max(SERVICE_MAX_TIMEOUT_MS),
});
const inflight = z.number().int().min(1).max(SERVICE_MAX_INFLIGHT);
/**
 * What an operation does to the owner's state, in the only two words the fleet uses.
 *
 * It is a closed set on purpose. A grant of kind `service-read` admits every `read` operation of a
 * service without naming any of them, so the owner — who writes the descriptor — decides what
 * counts as reading, and the fleet operator never has to enumerate another project's operation
 * names. That delegation only works if both sides spell the word the same way: a descriptor that
 * says `act`, `demand` or `mutate` describes something the wire cannot classify, and any invariant
 * written over one vocabulary is silently inapplicable to the other.
 */
export const ServiceEffectSchema = z.enum(['read', 'write']);
export type ServiceEffect = z.infer<typeof ServiceEffectSchema>;
export const ServiceOperationSchema = z.strictObject({
  id: ServiceOperationIdSchema,
  path: OwnerRoutePathSchema,
  effect: ServiceEffectSchema,
  limits: ServiceLimitsSchema,
  response: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('unary') }),
    z.strictObject({
      kind: z.literal('stream'),
      lifetimeMs: z.number().int().min(1).max(SERVICE_MAX_TIMEOUT_MS).optional(),
      idleTimeoutMs: z.number().int().min(0).max(SERVICE_MAX_TIMEOUT_MS).optional(),
    }),
  ]),
});
export const ServiceDescriptorSchema = z
  .strictObject({
    service: ServiceIdSchema,
    revision: ServiceRevisionSchema,
    maxInflight: inflight,
    // No count: an owner contract decides how many operations it has, and the descriptor file's
    // byte limit (SERVICE_MAX_DESCRIPTOR_BYTES) is what bounds the node's work reading it.
    operations: z.array(ServiceOperationSchema).min(1),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const [index, operation] of value.operations.entries()) {
      if (ids.has(operation.id))
        ctx.addIssue({ code: 'custom', path: ['operations', index, 'id'], message: 'duplicate operation' });
      if (paths.has(operation.path))
        ctx.addIssue({
          code: 'custom',
          path: ['operations', index, 'path'],
          message: 'duplicate route path',
        });
      ids.add(operation.id);
      paths.add(operation.path);
    }
  });
export type ServiceDescriptor = z.infer<typeof ServiceDescriptorSchema>;

export const ServiceBindingSchema = z.strictObject({
  service: ServiceIdSchema,
  descriptorPath: AbsoluteFilePathSchema,
  socketPath: UnixSocketPathSchema,
  endpointPath: OwnerRoutePathSchema,
  maxInflight: inflight,
  limits: ServiceLimitsSchema,
});
export type ServiceBinding = z.infer<typeof ServiceBindingSchema>;

const ServiceGrantBaseSchema = z.strictObject({
  caller: NodeIdSchema,
  target: NodeIdSchema,
  service: ServiceIdSchema,
});
export const ServiceGrantSchema = z.union([
  ServiceGrantBaseSchema.extend({ scope: z.strictObject({ kind: z.literal('service-read') }) }),
  ServiceGrantBaseSchema.extend({
    scope: z.strictObject({ kind: z.literal('operation'), operation: ServiceOperationIdSchema }),
  }),
]);
export type ServiceGrant = z.infer<typeof ServiceGrantSchema>;
/**
 * No count: a node declares the callers of every owner's declaration in one list, so any count here
 * is reached by adding services, not by a wrong file. What carries grants from elsewhere — owner
 * declarations, the fleet bundle, lane frames — is bounded in bytes; a configuration file is the
 * operator's own.
 */
export const ServiceGrantsSchema = z.array(ServiceGrantSchema).superRefine((grants, ctx) => {
  const keys = new Set<string>();
  for (const [index, grant] of grants.entries()) {
    const key = JSON.stringify([grant.caller, grant.target, grant.service, grant.scope]);
    if (keys.has(key))
      ctx.addIssue({ code: 'custom', path: [index], message: 'duplicate or conflicting operation grant' });
    keys.add(key);
  }
});
/** One service per binding and one budget per socket, for every schema that carries bindings. */
export function checkServiceBindings(
  value: { bindings: readonly ServiceBinding[] },
  ctx: z.RefinementCtx,
): void {
  const ids = new Set<string>(),
    sockets = new Set<string>();
  for (const [index, binding] of value.bindings.entries()) {
    if (ids.has(binding.service))
      ctx.addIssue({ code: 'custom', path: ['bindings', index], message: 'duplicate service binding' });
    if (sockets.has(binding.socketPath))
      ctx.addIssue({
        code: 'custom',
        path: ['bindings', index],
        message: 'socket already has a service budget',
      });
    ids.add(binding.service);
    sockets.add(binding.socketPath);
  }
}

export const ServicePolicySchema = z
  .strictObject({
    bindings: z.array(ServiceBindingSchema),
    grants: ServiceGrantsSchema,
  })
  .superRefine(checkServiceBindings);
export type ServicePolicy = z.infer<typeof ServicePolicySchema>;
