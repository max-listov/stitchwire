/** Writing the CLI's configuration files with the mode they must keep. */

import { writeFileAtomicSync } from 'stitchkit/files';
import { ensureStateDir } from '../config/io.ts';
import { configIdentity } from '../config/identity.ts';
import { withConfigLock } from '../config/transaction.ts';
/** 64 hex characters from two UUIDs — long enough that a digest comparison is the only realistic
 *  way in, and generated locally so a token never travels to be created. */
export function freshToken(): string {
  return crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
}

/** Written with the mode it must keep: a config carrying a token is readable by its owner only, and
 *  leaving that to the operator is how a token ends up world-readable on one machine out of three. */
export async function createConfigFile(path: string, value: unknown): Promise<void> {
  const target = configIdentity(path);
  ensureStateDir(target);
  await withConfigLock(target, () => {
    writeFileAtomicSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, replace: false });
  });
}

/** The arguments that are neither flags nor the value of one: what the command was given to work on. */
export function positional(argv: string[]): string[] {
  return argv.filter((entry, index) => !entry.startsWith('--') && !(argv[index - 1] ?? '').startsWith('--'));
}

export function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
