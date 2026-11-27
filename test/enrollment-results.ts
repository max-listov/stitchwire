import type { EnrollmentFailure, EnrollmentResult } from '../packages/contracts/src/enrollment/result.ts';

type Ready = Extract<EnrollmentResult, { status: 'ready' }>;

/** The refusal a result carries; null when the operation succeeded. */
export function refusalOf(result: EnrollmentResult): EnrollmentFailure | null {
  return result.status === 'failed' ? result.failure : null;
}

/** The proof a `ready` result carries; undefined when the result is not `ready`. */
export function proofOf(result: EnrollmentResult): Ready['proof'] | undefined {
  return result.status === 'ready' ? result.proof : undefined;
}

/** The measured runtime of a `ready` or `detached` result; undefined for any other status. */
export function runtimeOf(result: EnrollmentResult): Ready['runtime'] | undefined {
  return result.status === 'ready' || result.status === 'detached' ? result.runtime : undefined;
}

/** The credential digests a node result names; none for a refusal or a broker's result. */
export function credentialsOf(
  result: EnrollmentResult,
): Extract<EnrollmentResult, { kind: 'node' }>['credentials'] {
  return result.status !== 'failed' && result.kind === 'node' ? result.credentials : [];
}

/** The bootstrap material a broker's result hands out; undefined for any other result. */
export function materialOf(result: EnrollmentResult) {
  return result.status !== 'failed' && result.kind === 'admission' ? result.material : undefined;
}
