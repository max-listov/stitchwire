/**
 * Atomic replacement of an installed macOS bundle by a verified candidate. The swap is
 * `renameatx_np(..., RENAME_SWAP)`; a candidate that fails verification after the swap is swapped
 * back, and one whose rollback failed too is kept with a recovery marker, because it may hold the
 * only copy of the previous bundle. What "verified" means is the caller's: this module knows no
 * signature and no fingerprint.
 */
import { dlopen, FFIType, ptr, read } from 'bun:ffi';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { errnoOf } from '../../packages/local-client/src/errno.ts';

/** Left in a staging candidate whose rollback failed: that candidate may hold the only copy of the old bundle. */
export const RECOVERY_MARKER = 'RECOVERY';

/**
 * A swap whose verification failed and whose rollback failed too. Only this means a candidate may hold
 * the only copy of the previous bundle; any other error, an `AggregateError` from elsewhere included,
 * leaves the installed bundle where it was.
 */
export class BundleRollbackFailed extends AggregateError {
  override name = 'BundleRollbackFailed';
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errnoName(code: number): string {
  return Object.entries(constants.errno).find(([, value]) => value === code)?.[0] ?? `errno ${code}`;
}

export function exchangeBundles(staged: string, installed: string): void {
  const libc = dlopen('/usr/lib/libSystem.B.dylib', {
    renameatx_np: {
      args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    __error: { args: [], returns: FFIType.ptr },
  });
  const next = Buffer.from(`${staged}\0`);
  const current = Buffer.from(`${installed}\0`);
  try {
    // Darwin: AT_FDCWD = -2; RENAME_SWAP = 2.
    if (libc.symbols.renameatx_np(-2, ptr(next), -2, ptr(current), 2) !== 0) {
      const location = libc.symbols.__error();
      const code = location === null ? -1 : read.i32(location, 0);
      throw new Error(
        `Atomic bundle exchange failed (renameatx_np: ${errnoName(code)}); installed bundle was retained`,
      );
    }
  } finally {
    libc.close();
  }
}

export function installVerifiedBundle(
  staged: string,
  installed: string,
  verify: (path: string) => void,
  exchange = exchangeBundles,
): void {
  verify(staged);
  const replacing = existsSync(installed);
  if (replacing) exchange(staged, installed);
  else renameSync(staged, installed);
  try {
    verify(installed);
  } catch (cause) {
    try {
      if (replacing) exchange(staged, installed);
      else renameSync(installed, staged);
    } catch (rollback) {
      throw new BundleRollbackFailed(
        [cause, rollback],
        `Bundle verification and rollback failed; ${replacing ? 'the previous bundle is' : 'the rejected bundle is'} at ${replacing ? staged : installed}`,
        { cause },
      );
    }
    throw cause;
  }
  if (replacing) rmSync(staged, { recursive: true, force: true });
}

/** A candidate left by a failed rollback is never deleted or built over: an operator restores from it first. */
function refuseOverRecovery(stagingRoot: string): void {
  for (const entry of readdirSync(stagingRoot)) {
    if (existsSync(join(stagingRoot, entry, RECOVERY_MARKER))) {
      throw new Error(
        `refusing to install: ${join(stagingRoot, entry)} holds a bundle kept for recovery (${RECOVERY_MARKER}); restore or remove it first`,
      );
    }
  }
}

/** Remove the staging root only once no other run's candidate is inside it. */
function removeIfEmpty(directory: string): void {
  try {
    rmdirSync(directory);
  } catch (error) {
    const code = errnoOf(error);
    if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error;
  }
}

/**
 * Build a candidate inside `<installed>.install.noindex` and swap it in. Each run owns only its own candidate
 * directory, so concurrent runs never delete each other's work; a candidate whose rollback failed is kept with
 * a recovery marker, and every later run refuses until an operator has dealt with it.
 */
export function replaceThroughStaging(
  installed: string,
  build: (staged: string) => void,
  verify: (path: string) => void,
  exchange = exchangeBundles,
): void {
  const stagingRoot = `${installed}.install.noindex`;
  mkdirSync(stagingRoot, { recursive: true });
  refuseOverRecovery(stagingRoot);
  const work = mkdtempSync(join(stagingRoot, 'candidate-'));
  let keepForRecovery = false;
  try {
    const staged = join(work, 'Candidate.app');
    build(staged);
    installVerifiedBundle(staged, installed, verify, exchange);
  } catch (error) {
    if (error instanceof BundleRollbackFailed) {
      keepForRecovery = true;
      writeFileSync(
        join(work, RECOVERY_MARKER),
        `${[error.message, ...error.errors.map(errorText)].join('\n')}\n`,
      );
    }
    throw error;
  } finally {
    if (!keepForRecovery) {
      rmSync(work, { recursive: true, force: true });
      removeIfEmpty(stagingRoot);
    }
  }
}
