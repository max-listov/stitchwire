import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { errnoOf } from '../packages/local-client/src/errno.ts';

async function listing(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Every installed copy of one package under `root/node_modules`, at any depth. A framework that is
 * installed twice is two implementations in one process, so "how many copies" is the question an
 * install proof has to answer, and a nested copy under another package is exactly what it must find.
 */
export async function installedCopies(root: string, name: string): Promise<string[]> {
  const found: string[] = [];
  async function visit(modules: string): Promise<void> {
    for (const entry of await listing(modules)) {
      if (entry.name.startsWith('.')) continue;
      const packages = entry.name.startsWith('@')
        ? (await listing(join(modules, entry.name))).map((child) => join(modules, entry.name, child.name))
        : [join(modules, entry.name)];
      for (const directory of packages) {
        const manifest = await stat(join(directory, 'package.json')).catch(() => undefined);
        if (manifest === undefined) continue;
        if (directory.endsWith(`node_modules/${name}`)) found.push(directory);
        await visit(join(directory, 'node_modules'));
      }
    }
  }
  await visit(join(root, 'node_modules'));
  return found.sort();
}
