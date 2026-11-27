import { ExclusiveLockError } from 'stitchkit/files';
import type {
  EnrollmentCode,
  EnrollmentFailure,
  EnrollmentPhase,
} from '../../../contracts/src/enrollment/result.ts';

/**
 * A refusal names what is wrong and keeps why. It does not name a phase: the same check runs in
 * several steps, and the step that was running is the one the operation reports.
 */
export class EnrollmentError extends Error {
  constructor(
    readonly code: EnrollmentCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

/**
 * The code of the refusal underneath, wherever along the causes it was measured: the operating
 * system's (`EACCES`), the runtime's (`ERR_INVALID_URL`) or the lock's (`LOCK_TIMEOUT`).
 */
function systemCodeOf(error: unknown): string | null {
  let current = error;
  for (let depth = 0; current instanceof Error && depth < 8; depth++) {
    if ('code' in current && typeof current.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(current.code))
      return current.code;
    current = current.cause;
  }
  return null;
}

function codeOf(error: unknown, systemCode: string | null): EnrollmentCode {
  if (error instanceof EnrollmentError) return error.code;
  if (error instanceof ExclusiveLockError) return 'busy';
  return systemCode === 'EACCES' || systemCode === 'EPERM' ? 'permission-denied' : 'io-failed';
}

export function failureOf(error: unknown, phase: EnrollmentPhase): EnrollmentFailure {
  const systemCode = systemCodeOf(error);
  return { code: codeOf(error, systemCode), phase, at: new Date().toISOString(), systemCode };
}
