import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/*
 * What the fixture did is recorded as files beside the marker, not as output: a command that is
 * being stopped has its output dropped, and the facts a test asks about are about the transaction.
 */
const [mode, marker] = Bun.argv.slice(2);
if (marker === undefined) throw new Error('marker missing');
const note = (name: string): void => appendFileSync(join(dirname(marker), name), '');
if (mode === 'transaction') {
  process.on('SIGTERM', () => {
    note('child-signalled');
    process.exitCode = 7;
    process.exit();
  });
  await Bun.sleep(1200);
  note('committed');
} else if (mode === 'lingering-child') {
  // Holds no pipe of the command, so nothing about the command's output waits for it.
  await Bun.sleep(60_000);
} else if (mode === 'owner' || mode === 'ignore' || mode === 'orphan' || mode === 'linger') {
  const child =
    mode === 'linger'
      ? Bun.spawn([process.execPath, import.meta.path, 'lingering-child', marker], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
      : Bun.spawn([process.execPath, import.meta.path, 'transaction', marker], {
          stdout: 'inherit',
          stderr: 'inherit',
        });
  let requests = 0;
  process.on('SIGTERM', () => {
    requests += 1;
    note(`owner-cancellation-${requests}`);
    if (mode === 'owner') {
      void child.exited.then(() => process.exit());
    } else if (mode === 'orphan' || mode === 'linger') process.exit();
  });
  writeFileSync(marker, JSON.stringify({ pid: process.pid, childPid: child.pid }));
  setInterval(() => {}, 1000);
} else throw new Error('unknown fixture mode');
