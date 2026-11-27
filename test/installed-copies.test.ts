import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedCopies } from '../scripts/installed-copies.ts';

async function install(root: string, path: string, name: string) {
  const directory = join(root, path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
}

test('the copy counter finds a nested copy and ignores packages that only share a name prefix', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-copies-'));
  try {
    await install(root, 'node_modules/framework', 'framework');
    await install(root, 'node_modules/framework-extra', 'framework-extra');
    expect(await installedCopies(root, 'framework')).toEqual([join(root, 'node_modules/framework')]);

    await install(root, 'node_modules/@scope/client', '@scope/client');
    await install(root, 'node_modules/@scope/client/node_modules/framework', 'framework');
    expect(await installedCopies(root, 'framework')).toEqual([
      join(root, 'node_modules/@scope/client/node_modules/framework'),
      join(root, 'node_modules/framework'),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a tree without node_modules holds no copies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-copies-'));
  try {
    expect(await installedCopies(root, 'framework')).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
