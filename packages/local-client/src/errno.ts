/**
 * The system error code (`ENOENT`, `EACCES`, …) a failed filesystem or socket call carries, or
 * `undefined` when the value has none. Not a public export: the SDK and the agent judge their own
 * filesystem failures with it, so the two read an error the same way.
 */
export function errnoOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
