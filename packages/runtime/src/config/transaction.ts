import { withExclusiveLock } from 'stitchkit/files';
import { configIdentity } from './identity.ts';

export function withConfigLock<T>(path: string, run: () => Promise<T> | T): Promise<T> {
  // A poll retries on its next tick; an operator gets a precise busy result instead of waiting
  // behind another mutation. The framework reclaims only a provably dead local process owner.
  return withExclusiveLock(`${configIdentity(path)}.lock`, run, { timeoutMs: 0 });
}
