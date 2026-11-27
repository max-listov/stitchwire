import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { DependencyManifestSchema, installedDependencyGraph } from '../scripts/dependency-graph.ts';

const root = resolve(import.meta.dir, '..');

async function manifestAt(path: string) {
  return DependencyManifestSchema.parse(await Bun.file(resolve(root, path)).json());
}

test('the workspaces build and test on one exact framework version that is the one installed', async () => {
  const declared = new Set<string>();
  for (const path of [
    'package.json',
    ...['runtime', 'contracts', 'local-client'].map((name) => `packages/${name}/package.json`),
  ]) {
    const version = (await manifestAt(path)).dependencies?.stitchkit;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    if (!version) throw new Error('Missing exact framework dependency');
    declared.add(version);
  }
  // The client ships the framework as a peer, so its exact copy is for building and testing it only.
  const client = await manifestAt('packages/client/package.json');
  const built = client.devDependencies?.stitchkit;
  expect(built).toMatch(/^\d+\.\d+\.\d+$/);
  if (!built) throw new Error('Missing exact framework devDependency in the client');
  declared.add(built);
  expect(declared.size).toBe(1);
  const resolved = new Set(
    (await installedDependencyGraph(root))
      .filter(({ manifest }) => manifest.name === 'stitchkit')
      .map(({ manifest }) => manifest.version),
  );
  expect(resolved).toEqual(declared);
});

/** Dotted versions compared part by part, never as text. */
function atMost(version: string, limit: string): boolean {
  const left = version.split('.').map(Number);
  const right = limit.split('.').map(Number);
  for (const [index, part] of left.entries()) {
    const other = right[index] ?? 0;
    if (part !== other) return part < other;
  }
  return true;
}

test('the client asks its consumer for the framework instead of carrying a copy', async () => {
  const client = await manifestAt('packages/client/package.json');
  expect(client.dependencies?.stitchkit).toBeUndefined();
  const floor = /^>=(\d+\.\d+\.\d+) <1$/.exec(client.peerDependencies?.stitchkit ?? '')?.[1];
  expect(floor).toBeDefined();
  // The floor is a version this client claims to work with; it cannot be above the one it is built on.
  expect(atMost(floor ?? '', client.devDependencies?.stitchkit ?? '')).toBe(true);
  expect(atMost('0.107.0', '0.106.1')).toBe(false);
});
