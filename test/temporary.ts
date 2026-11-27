import { mkdtempSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

// A short, process-owned directory keeps Unix paths bounded on both supported kernels.
const root = mkdtempSync('/tmp/wire-test-');
process.once('exit', () => rmSync(root, { recursive: true, force: true }));

export function temporaryFile(name: string): string {
  if (name === '' || name === '.' || name === '..' || basename(name) !== name)
    throw new Error('Test scratch file must be a basename');
  return join(root, name);
}
