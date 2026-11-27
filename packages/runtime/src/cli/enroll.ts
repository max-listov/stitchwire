import { parseJsonBytes, readRegularFileSync } from 'stitchkit/files';
import { EnrollmentOperationSchema } from '../../../contracts/src/enrollment/request.ts';
import { ENROLLMENT_REQUEST_BYTES } from '../enrollment/files.ts';
import { executeEnrollment } from '../enrollment/operation.ts';
import { out, readStdinBytes } from './io.ts';

/** `-` reads the request from stdin, so a remote administrator needs no request file on disk. */
async function requestValue(file: string): Promise<unknown> {
  try {
    // The bytes only: `executeEnrollment` owns the one parse of the request.
    return parseJsonBytes(
      file === '-'
        ? await readStdinBytes(ENROLLMENT_REQUEST_BYTES)
        : readRegularFileSync(file, { limit: ENROLLMENT_REQUEST_BYTES }),
    );
  } catch {
    // Any unreadable, oversized or invalid request is the same refusal, without its bytes.
    return null;
  }
}

/** One JSON result on stdout; exit 0 when the operation succeeded and 2 when it was refused. */
export async function runEnroll(argv: string[]): Promise<number> {
  const [operation, flag, file, ...extra] = argv;
  const parsed = EnrollmentOperationSchema.safeParse(operation);
  const usable = parsed.success && flag === '--request' && file !== undefined && extra.length === 0;
  const result = await executeEnrollment(
    usable ? await requestValue(file) : null,
    parsed.success ? parsed.data : null,
  );
  await out(`${JSON.stringify(result)}\n`);
  return result.status === 'failed' ? 2 : 0;
}
