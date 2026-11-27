import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installedDependencyGraph } from '../scripts/dependency-graph.ts';

test('inventory follows installed workspace edges, excludes stale cache and retains nested versions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-dependency-'));
  const manifest = async (path: string, value: object) => {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, 'package.json'), JSON.stringify(value));
  };
  try {
    await manifest('.', {
      name: 'fixture',
      version: '1.0.0',
      workspaces: ['packages/*'],
      dependencies: { library: '2.0.0' },
    });
    await manifest('packages/consumer', {
      name: 'consumer',
      devDependencies: { tool: '1.0.0' },
    });
    await manifest('node_modules/.bun/library@1/node_modules/library', { name: 'library', version: '1.0.0' });
    await manifest('node_modules/.bun/library@2/node_modules/library', {
      name: 'library',
      version: '2.0.0',
      dependencies: { nested: '1.0.0' },
      peerDependencies: { absentPeer: '*', installedPeer: '*' },
      peerDependenciesMeta: { absentPeer: { optional: true }, installedPeer: { optional: true } },
      devDependencies: { notInstalledDevTool: '*' },
    });
    await symlink('.bun/library@2/node_modules/library', join(root, 'node_modules/library'));
    await manifest('node_modules/.bun/library@2/node_modules/nested', { name: 'nested', version: '1.0.0' });
    await manifest('node_modules/nested', { name: 'nested', version: '2.0.0' });
    await manifest('node_modules/node_modules/nested', { name: 'nested', version: 'unused' });
    await manifest('node_modules/tool', {
      name: 'tool',
      version: '1.0.0',
      dependencies: { nested: '2.0.0' },
    });
    await manifest('node_modules/installedPeer', { name: 'installedPeer', version: '1.0.0' });
    const found = await installedDependencyGraph(root);
    expect(found.map(({ manifest: item }) => `${item.name}@${item.version}`)).toEqual([
      'installedPeer@1.0.0',
      'library@2.0.0',
      'nested@1.0.0',
      'nested@2.0.0',
      'tool@1.0.0',
    ]);
    await manifest('node_modules/tool', {
      name: 'tool',
      version: '1.0.0',
      dependencies: { missingRequired: '*' },
    });
    await expect(installedDependencyGraph(root)).rejects.toThrow(
      'Missing installed dependency missingRequired',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
