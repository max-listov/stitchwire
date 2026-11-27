import type { ContractDef, EndpointDef } from 'stitchkit';
import { requireContractOperationEffects } from 'stitchkit/contract';
import { SERVICE_MAX_TIMEOUT_MS } from './contracts.ts';
import { type ServiceDescriptor, ServiceDescriptorSchema } from './policy-schema.ts';
import { SERVICE_DEFAULT_REQUEST_BYTES } from './request-bounds.ts';

/** Projects a Stitchkit owner contract into the policy facts Wire must route and bound. */
export function serviceDescriptorFromContract<T extends Record<string, EndpointDef>>(
  contract: ContractDef<T, string>,
  config: {
    service: string;
    revision: string;
    maxInflight: number;
    responseBytes?: Partial<Record<keyof T, number>>;
  },
): ServiceDescriptor {
  const endpointNames = Object.keys(contract.endpoints);
  const effects = requireContractOperationEffects(contract);
  for (const name of Object.keys(config.responseBytes ?? {}))
    if (!Object.hasOwn(contract.endpoints, name))
      throw new TypeError(`Unknown responseBytes endpoint '${name}'`);
  const prefix = contract.meta.prefix.replace(/^\/+|\/+$/g, '');
  return ServiceDescriptorSchema.parse({
    service: config.service,
    revision: config.revision,
    maxInflight: config.maxInflight,
    operations: endpointNames.map((id) => {
      const endpoint = contract.endpoints[id];
      if (!endpoint) throw new TypeError(`Missing Stitchkit endpoint '${id}'`);
      const path = endpoint.path.replace(/^\/+|\/+$/g, '');
      const exposedOnHttp = endpoint.expose === undefined || endpoint.expose.includes('HTTP');
      if (
        endpoint.method !== 'POST' ||
        !exposedOnHttp ||
        endpoint.params !== undefined ||
        endpoint.multipart !== undefined ||
        endpoint.rawResponse === true ||
        endpoint.rawBody === true ||
        endpoint.responseMeta !== undefined ||
        endpoint.path.includes(':') ||
        endpoint.path.includes('*')
      ) {
        throw new TypeError(
          `Wire service endpoint '${id}' must be an HTTP POST with a static JSON route and response`,
        );
      }
      const stream = 'stream' in endpoint ? endpoint.stream : undefined;
      return {
        id,
        path: `/${[prefix, path].filter(Boolean).join('/')}`,
        effect: effects[id],
        limits: {
          requestBytes: endpoint.maxJsonBodyBytes ?? SERVICE_DEFAULT_REQUEST_BYTES,
          responseBytes: config.responseBytes?.[id] ?? 262_144,
          timeoutMs: endpoint.timeout ?? SERVICE_MAX_TIMEOUT_MS,
        },
        response:
          stream === undefined
            ? { kind: 'unary' as const }
            : {
                kind: 'stream' as const,
                ...(stream.lifetimeMs === undefined ? {} : { lifetimeMs: stream.lifetimeMs }),
                ...(stream.idleTimeoutSeconds === undefined
                  ? {}
                  : { idleTimeoutMs: stream.idleTimeoutSeconds * 1000 }),
              },
      };
    }),
  });
}
