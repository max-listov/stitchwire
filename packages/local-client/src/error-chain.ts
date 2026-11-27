import type { ClientErrorCode } from '../../contracts/src/door/client-error.ts';
import type { ServiceFailureCode } from '../../contracts/src/service/contracts.ts';
import { WireClientError } from './errors.ts';
import { WireServiceError } from './service.ts';

/** How many links of a `.cause` chain are read by default, the outermost error included. */
const DEFAULT_MAX_DEPTH = 16;

function readCause(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    return Reflect.get(value, 'cause');
  } catch {
    return undefined;
  }
}

/** A match that throws — `instanceof` on a Proxy whose `getPrototypeOf` trap throws — is no match. */
function matchSafely<T>(match: (node: unknown) => T | undefined, node: unknown): T | undefined {
  try {
    return match(node);
  } catch {
    return undefined;
  }
}

/**
 * Walk `.cause` (cycle-guarded, ignoring `AggregateError.errors`) and return the first match, at
 * most `maxDepth` links deep (16 by default, the outermost error included). Matching is by
 * `instanceof`: an error made by a second copy of this package elsewhere in the dependency tree is
 * a different class and is not recognised. No input makes the walk throw: a link whose traps throw
 * ends it with no match.
 */
function findInCauseChain<T>(
  error: unknown,
  match: (node: unknown) => T | undefined,
  maxDepth: number,
): T | undefined {
  if (!Number.isInteger(maxDepth) || maxDepth < 1)
    throw new RangeError(`maxDepth must be a positive integer (got ${maxDepth})`);
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < maxDepth && current !== undefined && current !== null; depth++) {
    const matched = matchSafely(match, current);
    if (matched !== undefined) return matched;
    if (typeof current !== 'object' || seen.has(current)) return undefined;
    seen.add(current);
    current = readCause(current);
  }
  return undefined;
}

/** Locate the outermost `WireServiceError` along the `.cause` chain. */
export function extractWireServiceError(
  error: unknown,
  maxDepth = DEFAULT_MAX_DEPTH,
): WireServiceError | undefined {
  return findInCauseChain(error, (node) => (node instanceof WireServiceError ? node : undefined), maxDepth);
}

/** Locate the outermost `WireClientError` along the `.cause` chain. */
export function extractWireClientError(
  error: unknown,
  maxDepth = DEFAULT_MAX_DEPTH,
): WireClientError | undefined {
  return findInCauseChain(error, (node) => (node instanceof WireClientError ? node : undefined), maxDepth);
}

/**
 * A Wire failure code with the side that produced it. The two code spaces overlap (`timeout`,
 * `cancelled`, `unavailable`, `capacity`, ...): `service` is the remote service's or the route's
 * refusal (`WireServiceError`), `client` is this process's local failure (`WireClientError`).
 */
export type WireErrorCode =
  | { source: 'service'; code: ServiceFailureCode }
  | { source: 'client'; code: ClientErrorCode };

/**
 * The code and source of the nearest `WireServiceError` or `WireClientError` along the `.cause`
 * chain (outermost first), or `undefined` when the failure did not originate from Wire.
 */
export function wireErrorCode(error: unknown, maxDepth = DEFAULT_MAX_DEPTH): WireErrorCode | undefined {
  return findInCauseChain<WireErrorCode>(
    error,
    (node) =>
      node instanceof WireServiceError
        ? { source: 'service', code: node.outcome.code }
        : node instanceof WireClientError
          ? { source: 'client', code: node.code }
          : undefined,
    maxDepth,
  );
}
