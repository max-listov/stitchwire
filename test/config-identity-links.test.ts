import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configIdentity } from '../packages/runtime/src/config/identity.ts';

test('canonical path callbacks accept 42 ordinary descriptors while real excessive symlink traversal refuses', () => {
  const root = realpathSync(mkdtempSync('/tmp/wire-path-depth-'));
  try {
    const paths = Array.from({ length: 42 }, (_, index) => join(root, `descriptor-${index}.json`));
    for (const path of paths) writeFileSync(path, '{}');
    expect(paths.map(configIdentity)).toEqual(paths);
    for (let index = 42; index >= 0; index--)
      symlinkSync(
        index === 42 ? (paths[0] ?? '') : join(root, `link-${index + 1}`),
        join(root, `link-${index}`),
      );
    expect(() => configIdentity(join(root, 'link-0'))).toThrow('too many symbolic links');
    const first = paths[0];
    if (!first) throw new Error('empty fixture');
    expect(configIdentity(join(root, 'link-42'))).toBe(first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
