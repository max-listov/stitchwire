import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { errnoOf } from '../packages/local-client/src/errno.ts';

const Versions = z.record(z.string(), z.string());
export const DependencyManifestSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  license: z.union([z.string(), z.object({ type: z.string() })]).optional(),
  licenses: z.array(z.object({ type: z.string() })).optional(),
  dependencies: Versions.optional(),
  devDependencies: Versions.optional(),
  optionalDependencies: Versions.optional(),
  peerDependencies: Versions.optional(),
  peerDependenciesMeta: z.record(z.string(), z.object({ optional: z.boolean().optional() })).optional(),
  workspaces: z.array(z.string()).optional(),
});
export type DependencyManifest = z.infer<typeof DependencyManifestSchema>;
const InstalledPackageSchema = DependencyManifestSchema.extend({ version: z.string() });
type InstalledPackage = z.infer<typeof InstalledPackageSchema>;

function absent(error: unknown): boolean {
  return errnoOf(error) === 'ENOENT';
}

/** Resolve installed package directories without executing their entrypoints or bypassing exports. */
async function resolvePackage(name: string, from: string): Promise<string | undefined> {
  if (!/^(?:@[^/]+\/)?[^/]+$/.test(name) || name === '.' || name === '..') {
    throw new Error('Invalid dependency package name');
  }
  let directory = from;
  for (;;) {
    const candidate = join(directory, 'node_modules', name, 'package.json');
    if (basename(directory) !== 'node_modules') {
      try {
        if (!(await stat(candidate)).isFile()) throw new Error('Dependency manifest is not a file');
        return realpath(candidate);
      } catch (error) {
        if (!absent(error)) throw error;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function edges(manifest: DependencyManifest, workspace: boolean): Map<string, boolean> {
  const required = new Map<string, boolean>();
  for (const name of Object.keys(manifest.dependencies ?? {})) required.set(name, true);
  if (workspace) for (const name of Object.keys(manifest.devDependencies ?? {})) required.set(name, true);
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) required.set(name, false);
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (!required.has(name)) required.set(name, manifest.peerDependenciesMeta?.[name]?.optional !== true);
  }
  return required;
}

export async function installedDependencyGraph(
  root: string,
): Promise<Array<{ directory: string; manifest: InstalledPackage }>> {
  const rootFile = await realpath(join(root, 'package.json'));
  const rootManifest = DependencyManifestSchema.parse(JSON.parse(await readFile(rootFile, 'utf8')));
  const workspaces = new Set([rootFile]);
  for (const pattern of rootManifest.workspaces ?? []) {
    for await (const file of new Bun.Glob(`${pattern}/package.json`).scan({ cwd: root, onlyFiles: true })) {
      workspaces.add(await realpath(resolve(root, file)));
    }
  }
  const pending = [...workspaces];
  const visited = new Set<string>();
  const result: Array<{ directory: string; manifest: InstalledPackage }> = [];
  for (let index = 0; index < pending.length; index++) {
    const file = pending[index];
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const manifest = DependencyManifestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
    const directory = dirname(file);
    if (!workspaces.has(file)) result.push({ directory, manifest: InstalledPackageSchema.parse(manifest) });
    for (const [name, required] of edges(manifest, workspaces.has(file))) {
      const resolved = await resolvePackage(name, directory);
      if (resolved) pending.push(resolved);
      else if (required) throw new Error(`Missing installed dependency ${name} required by ${manifest.name}`);
    }
  }
  return result.sort(
    (a, b) =>
      a.manifest.name.localeCompare(b.manifest.name) || a.manifest.version.localeCompare(b.manifest.version),
  );
}
