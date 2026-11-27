import type { EnrollmentCode } from '../../../contracts/src/enrollment/result.ts';
import { EnrollmentError } from './failure.ts';

/** How long a refusal of each code may be an observation still on its way, in milliseconds. */
export type Patience = ReadonlyMap<EnrollmentCode, number>;

/**
 * How long a mutation waits for its own effects, in milliseconds. It is the sum of the default
 * periods those effects pass through, not a measurement: the agent notices its rewritten
 * configuration within its configuration watch (5 s) and re-reads its declarations at once, a broker
 * notices its new edition within the default fleet `pollMs` (5 s), and a lane that reload dropped
 * redials within the default `reconnect.maxDelayMs` (10 s). A node configured with longer periods
 * can need more than this.
 */
export const OWN_EFFECT_MS = 20_000;

/** A mutation waits for its own effects: a broker reload, a door replaced, declarations acknowledged. */
export const OWN_EFFECTS: Patience = new Map<EnrollmentCode, number>(
  (
    [
      'broker-unavailable',
      'runtime-unavailable',
      'bundle-conflict',
      'declaration-refused',
      'handshake-refused',
    ] satisfies EnrollmentCode[]
  ).map((code) => [code, OWN_EFFECT_MS]),
);
/**
 * A node judged by its own kept copy follows that copy until it agrees with the brokers: a broker
 * ahead of it, a broker behind it, or tables drifting until the reconciler's self-reload, which runs
 * at most three times a minute. Only edition disagreement earns this longer ceiling.
 */
export const KEPT_EDITION: Patience = new Map<EnrollmentCode, number>([
  ['bundle-stale', 90_000],
  ['bundle-conflict', 90_000],
]);
/** A read-only answer about delivered material is given at once. */
export const AT_ONCE: Patience = new Map();

export function patience(...parts: Patience[]): Patience {
  const merged = new Map<EnrollmentCode, number>();
  for (const part of parts)
    for (const [code, ceiling] of part) merged.set(code, Math.max(ceiling, merged.get(code) ?? 0));
  return merged;
}

/**
 * Wait on observations, never on a fixed delay. A refusal outside the patience is final at once;
 * inside it the observation is read again until its ceiling, which bounds the start of the last
 * attempt, so the wait ends at most one attempt later.
 */
export async function settled<T>(observe: () => Promise<T>, waits: Patience): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      return await observe();
    } catch (error) {
      const ceiling = error instanceof EnrollmentError ? waits.get(error.code) : undefined;
      if (ceiling === undefined || Date.now() - started >= ceiling) throw error;
      await Bun.sleep(100);
    }
  }
}
