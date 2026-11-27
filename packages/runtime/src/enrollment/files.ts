import {
  readJsonFileSync,
  RegularFileError,
  readRegularFileSync,
  writeFileAtomicSync,
} from 'stitchkit/files';
import type { z } from 'zod';
import { errnoOf } from '../../../local-client/src/errno.ts';
import { EnrollmentError } from './failure.ts';

/** The ceiling of one enrollment request or of a record enrollment itself writes, from a file or stdin. */
export const ENROLLMENT_REQUEST_BYTES = 1024 * 1024;

/**
 * A bounded record under a schema; the caller names the ceiling of the kind of file it reads, the
 * same one the agent applies to that file, so enrollment never refuses what the agent accepts. An
 * operating-system refusal keeps its own error (access denied, missing file); bytes that are not the
 * record are `state-invalid`, and none of them reach a result.
 */
export function readValue<T>(path: string, schema: z.ZodType<T>, maxBytes: number): T {
  try {
    return readJsonFileSync(path, schema, { limit: maxBytes });
  } catch (cause) {
    if (cause instanceof RegularFileError) throw new EnrollmentError('state-invalid', { cause });
    throw cause;
  }
}

export function writePrivate(path: string, value: unknown): void {
  writeFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Create a file that must not replace another. Finding exactly these bytes already there is the
 * same outcome, which is what lets an interrupted installation resume; any other file is refused.
 */
export function writeOnce(path: string, bytes: Uint8Array, mode: number, maxBytes: number): void {
  try {
    writeFileAtomicSync(path, bytes, { mode, replace: false });
  } catch (cause) {
    const exists = errnoOf(cause) === 'EEXIST';
    if (!exists || !Buffer.from(bytes).equals(readRegularFileSync(path, { limit: maxBytes }))) throw cause;
  }
}
