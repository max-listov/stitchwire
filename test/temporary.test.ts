import { expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { temporaryFile } from './temporary.ts';

test('test files have a private directory and reject parent traversal', () => {
  const file = temporaryFile('owned');
  expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
  if (!process.getuid) throw new Error('Unix identity required');
  expect(statSync(dirname(file)).uid).toBe(process.getuid());
  for (const name of ['', '.', '..', '../foreign', '/tmp/foreign'])
    expect(() => temporaryFile(name)).toThrow('basename');
});

test('independent test processes cannot reuse another run and clean only their own files', async () => {
  const retained = temporaryFile('retained');
  await Bun.write(retained, 'owned by parent');
  const launch = async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        '-e',
        `import { temporaryFile } from ${JSON.stringify(import.meta.resolve('./temporary.ts'))};
       const file = temporaryFile('same-name'); await Bun.write(file, 'owned'); console.log(file);`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const file = (await new Response(child.stdout).text()).trim();
    expect(await child.exited).toBe(0);
    expect(file).not.toBe('');
    expect(existsSync(dirname(file))).toBe(false);
    return file;
  };
  const [first, second] = await Promise.all([launch(), launch()]);
  expect(first).not.toBe(second);
  expect(await Bun.file(retained).text()).toBe('owned by parent');
});
