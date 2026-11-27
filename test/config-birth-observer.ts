/** Separate process observes staging files before publication; no credential bytes are read or printed. */
import { existsSync, lstatSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { isAtomicStagingName } from 'stitchkit/files';
const [root] = process.argv.slice(2);
if (!root) throw new Error('missing observer root');
const seen = new Map<string, number>();
writeSync(1, 'ready\n');
while (!existsSync(join(root, 'finished'))) {
  for (const name of readdirSync(root)) {
    if (!isAtomicStagingName(name) && name !== 'unsafe-control') continue;
    const info = lstatSync(join(root, name), { throwIfNoEntry: false });
    if (info?.isFile() && !seen.has(name)) seen.set(name, info.mode & 0o777);
  }
}
writeSync(
  1,
  `${JSON.stringify([...seen].map(([name, mode]) => ({ staging: isAtomicStagingName(name), mode })))}\n`,
);
