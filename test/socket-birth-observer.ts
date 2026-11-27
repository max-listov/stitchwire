/**
 * Watches for a Unix socket to appear and prints the modes its directory and the socket had when it
 * first saw each: `<directory> <socket>` in octal, `-` for a directory that already existed when it
 * started. It polls without pausing, because a pause is exactly where a mode narrowed after creation hides.
 *
 * `ready` is written synchronously before the loop, so the parent binds only once the observer is looking.
 */
import { lstatSync, writeSync } from 'node:fs';

const [directory, socket] = process.argv.slice(2);
if (directory === undefined || socket === undefined)
  throw new Error('usage: socket-birth-observer <directory> <socket>');
const octal = (mode: number) => (mode & 0o777).toString(8);
let directoryMode = lstatSync(directory, { throwIfNoEntry: false }) === undefined ? undefined : '-';
writeSync(1, 'ready\n');
for (;;) {
  if (directoryMode === undefined) {
    const found = lstatSync(directory, { throwIfNoEntry: false });
    if (found !== undefined) directoryMode = octal(found.mode);
  }
  const found = lstatSync(socket, { throwIfNoEntry: false });
  if (found?.isSocket()) {
    // Directory and socket can both appear between this loop's two reads; the directory is then read now.
    directoryMode ??= octal(lstatSync(directory).mode);
    writeSync(1, `${directoryMode} ${octal(found.mode)}\n`);
    break;
  }
}
