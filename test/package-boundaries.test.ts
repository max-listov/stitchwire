import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const root = resolve(import.meta.dir, '..');
function sources(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(resolve(path, entry.name))
      : entry.name.endsWith('.ts')
        ? [resolve(path, entry.name)]
        : [],
  );
}
test('contracts and local client are shared leaves while client/runtime never import each other', () => {
  for (const name of ['contracts', 'local-client', 'client', 'runtime']) {
    const directory = resolve(root, 'packages', name);
    const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
    // npm receives the client from its generated copy in dist/, never from this manifest.
    expect(manifest.private).toBe(true);
    expect(manifest.publishConfig).toBeUndefined();
    expect(JSON.parse(readFileSync(resolve(directory, 'tsconfig.json'), 'utf8')).include).toContain('src');
    for (const file of sources(resolve(directory, 'src'))) {
      // Every specifier form: `import … from`, `export … from`, a bare side-effect `import '…'` and `import('…')`.
      for (const match of readFileSync(file, 'utf8').matchAll(
        /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g,
      )) {
        const specifier = match[1];
        if (!specifier?.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        expect(target.startsWith(`${root}/`)).toBe(true);
        for (const other of name === 'contracts'
          ? ['runtime', 'client', 'local-client']
          : name === 'local-client'
            ? ['runtime', 'client']
            : name === 'client'
              ? ['runtime']
              : ['client'])
          expect(target.startsWith(`${resolve(root, 'packages', other)}/`)).toBe(false);
      }
    }
  }
});

test('workspace value-import graph is acyclic', () => {
  const files = ['contracts', 'local-client', 'client', 'runtime'].flatMap((name) =>
    sources(resolve(root, 'packages', name, 'src')),
  );
  const graph = new Map<string, string[]>();
  const parser = new Bun.Transpiler({ loader: 'ts' });
  for (const file of files) {
    const imports = parser
      .scanImports(readFileSync(file, 'utf8').replace(/^#![^\n]*\n/, ''))
      .filter((entry) => entry.path.startsWith('.'))
      .map((entry) => resolve(dirname(file), entry.path));
    graph.set(file, imports);
  }
  const finished = new Set<string>();
  const active = new Set<string>();
  function visit(file: string): void {
    if (!graph.has(file) || finished.has(file)) return;
    if (active.has(file)) throw new Error(`Circular workspace value import: ${file.slice(root.length + 1)}`);
    active.add(file);
    for (const target of graph.get(file) ?? []) visit(target);
    active.delete(file);
    finished.add(file);
  }
  for (const file of files) visit(file);
  expect(finished.size).toBe(files.length);
});
