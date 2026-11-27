/**
 * The composed path of a door endpoint, read from the contract that defines it.
 *
 * `defineContract` computes `prefix + path` when it registers a typed handler, but does not hand
 * that string back. A raw route, a client and a document that each restate the composition by hand
 * diverge silently the moment a prefix changes: the type checker sees string literals that are
 * individually valid. Deriving the path here keeps the contract the only place the composition
 * exists.
 */
export function doorPath<T extends Record<string, { path: string }>>(
  contract: { meta: { prefix: string }; endpoints: T },
  endpoint: keyof T & string,
): string {
  const prefix = contract.meta.prefix.replace(/^\/+|\/+$/g, '');
  const definition = contract.endpoints[endpoint];
  if (definition === undefined) throw new Error(`unknown door endpoint: ${endpoint}`);
  const path = definition.path;
  return prefix === '' ? path : `/${prefix}${path}`;
}
