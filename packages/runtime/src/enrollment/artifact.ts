import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readRegularFileSync } from 'stitchkit/files';
import {
  type EnrollmentArtifact,
  MAX_ENROLLMENT_ARTIFACT_BYTES,
  supportsBun,
} from '../../../contracts/src/enrollment/request.ts';
import { sha256 } from '../config/io.ts';
import { EnrollmentError } from './failure.ts';
import { writeOnce } from './files.ts';
import type { Installation } from './installation.ts';
import { command } from './native.ts';

export function fileDigest(path: string): string {
  return sha256(readRegularFileSync(path, { limit: MAX_ENROLLMENT_ARTIFACT_BYTES }));
}

/**
 * The delivered runtime is the requested bytes, runs under a supported Bun and reports the fleet's
 * exact version. These facts do not change while one operation waits, so they are measured once.
 */
export async function checkArtifact(installation: Installation, expectedVersion: string): Promise<void> {
  if (process.platform !== 'linux') throw new EnrollmentError('supervisor-failed');
  const { artifact, supervision } = installation;
  try {
    const bun = await command(supervision.bun, ['--version']);
    if (bun.code !== 0 || !supportsBun(bun.text)) throw new EnrollmentError('version-mismatch');
    const source = existsSync(artifact.destination) ? artifact.destination : artifact.source;
    if (fileDigest(source) !== artifact.sha256) throw new EnrollmentError('artifact-mismatch');
    const version = await command(supervision.bun, [source, '--version']);
    if (version.code !== 0 || version.text !== expectedVersion) throw new EnrollmentError('version-mismatch');
  } catch (cause) {
    if (cause instanceof EnrollmentError) throw cause;
    throw new EnrollmentError('artifact-mismatch', { cause });
  }
}

/** Copy the runtime into place once; an interrupted copy resumes on exactly the same bytes. */
export function installArtifact(artifact: EnrollmentArtifact): void {
  try {
    if (!existsSync(artifact.destination)) {
      const bytes = readRegularFileSync(artifact.source, { limit: MAX_ENROLLMENT_ARTIFACT_BYTES });
      if (sha256(bytes) !== artifact.sha256) throw new EnrollmentError('artifact-mismatch');
      mkdirSync(dirname(artifact.destination), { recursive: true, mode: 0o700 });
      writeOnce(artifact.destination, bytes, 0o700, MAX_ENROLLMENT_ARTIFACT_BYTES);
    }
    if (fileDigest(artifact.destination) !== artifact.sha256) throw new EnrollmentError('artifact-mismatch');
  } catch (cause) {
    if (cause instanceof EnrollmentError) throw cause;
    throw new EnrollmentError('artifact-mismatch', { cause });
  }
}
