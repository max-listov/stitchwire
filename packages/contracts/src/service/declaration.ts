import { z } from 'zod';
import { NodeIdSchema } from '../protocol/identity.ts';
import { schemaParse } from '../protocol/schema-parse.ts';
import { ServiceIdSchema, ServiceOperationIdSchema } from './contracts.ts';
import { ServiceBindingSchema, ServiceGrantsSchema } from './policy-schema.ts';

/** The most services one node's owners may declare: each costs an admission key and a socket budget. */
export const MAX_DECLARED_SERVICES = 32;

/**
 * A prefix of service names the fleet lets one node serve, ending in a dot: `owner.` admits
 * `owner.delivery` and `owner.analytics.read`, never `owner` itself and never `ownerx.delivery`.
 */
export const ServiceNamespaceSchema = z
  .string()
  .max(127)
  .regex(/^[a-z0-9][a-z0-9._-]*\.$/, 'a service namespace is a service-name prefix ending in "."');

export function serviceInNamespace(namespace: string, service: string): boolean {
  return service.length > namespace.length && service.startsWith(namespace);
}

/** One node that may call the declared service, and what it may do there. */
export const DeclaredCallerSchema = z.strictObject({
  caller: NodeIdSchema,
  scope: z.union([
    z.strictObject({ kind: z.literal('service-read') }),
    z.strictObject({ kind: z.literal('operation'), operation: ServiceOperationIdSchema }),
  ]),
});

/**
 * What an owner installs beside its service: where the node reaches it, and who may call it.
 *
 * The file is the owner's. The node reads it and tells the brokers who may call; nobody else edits
 * it, and adding a service or a reader is an edit here, not a request to whoever runs the fleet.
 */
export const ServiceDeclarationSchema = z
  .strictObject({
    binding: ServiceBindingSchema,
    callers: z.array(DeclaredCallerSchema).default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    for (const [index, entry] of value.callers.entries()) {
      const key = JSON.stringify([entry.caller, entry.scope]);
      if (seen.has(key))
        ctx.addIssue({ code: 'custom', path: ['callers', index], message: 'duplicate caller scope' });
      seen.add(key);
    }
  });
export type ServiceDeclaration = z.infer<typeof ServiceDeclarationSchema>;
export type ServiceDeclarationInput = z.input<typeof ServiceDeclarationSchema>;

/**
 * The largest declaration file a node reads, and the only bound on how many callers it names. A
 * caller entry takes under a hundred bytes, and a caller granted write operations one by one takes
 * one entry per operation, so this admits several hundred; a bigger file is a wrong path, and the
 * node polls it every few seconds.
 */
export const SERVICE_MAX_DECLARATION_BYTES = 64 * 1024;

/**
 * Validates a parsed declaration the way the node agent does, with the same one-line reason.
 *
 * The agent calls exactly this function for every declaration file it polls, so an owner's tooling
 * that calls it before writing the file gets the verdict the node will reach, not a copy of it.
 */
export const parseServiceDeclaration = schemaParse(ServiceDeclarationSchema);

/** Node → broker: the complete set of grants to call services on this node that its owners declare. */
export const ServiceDeclareSchema = z.strictObject({ target: NodeIdSchema, grants: ServiceGrantsSchema });
export type ServiceDeclare = z.infer<typeof ServiceDeclareSchema>;

export const ServiceDeclareRefusalSchema = z.strictObject({
  service: ServiceIdSchema,
  caller: NodeIdSchema,
  detail: z.string().max(512),
});
export type ServiceDeclareRefusal = z.infer<typeof ServiceDeclareRefusalSchema>;

export const ServiceDeclareAckSchema = z.strictObject({
  accepted: z.number().int().min(0),
  // The count follows the admitted declaration's byte budget, including all bounded owner files.
  refused: z.array(ServiceDeclareRefusalSchema),
});
export type ServiceDeclareAck = z.infer<typeof ServiceDeclareAckSchema>;
