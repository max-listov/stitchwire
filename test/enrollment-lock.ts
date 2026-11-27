import { withExclusiveLock } from 'stitchkit/files';
import type { EnrollmentResult } from '../packages/contracts/src/enrollment/result.ts';
import { configIdentity } from '../packages/runtime/src/config/identity.ts';

/** Live fixture fleet polls compete for the same lock. Wait at most five seconds to establish
 * the deliberate test condition; actual CLI writers still report immediate busy. */
export function withFixtureConfigLock<T>(path: string, run: () => Promise<T>): Promise<T> {
  return withExclusiveLock(`${configIdentity(path)}.lock`, run, { timeoutMs: 5000 });
}

/**
 * What a caller does with `busy`: it asks again. A live fixture fleet polls its configuration and
 * holds the same lock for an instant, so one attempt may meet it. Only that exact refusal is asked
 * again, with one ceiling; every other result, and `busy` past the ceiling, is the answer.
 */
export async function pastBusy<T>(
  ask: () => Promise<T>,
  read: (answer: T) => EnrollmentResult,
  ceilingMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + ceilingMs;
  for (;;) {
    const answer = await ask();
    const result = read(answer);
    const busy =
      result.status === 'failed' &&
      result.failure.code === 'busy' &&
      result.failure.phase === 'configuration' &&
      result.failure.systemCode === 'LOCK_TIMEOUT';
    if (!busy || Date.now() >= deadline) return answer;
    await Bun.sleep(25);
  }
}
