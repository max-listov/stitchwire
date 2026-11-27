import { chmod, copyFile, lstat, mkdir, readdir, realpath, rm } from 'node:fs/promises';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { assertArtifactPrivacy } from './artifact-privacy.ts';

const rootFiles = [
  'package.json',
  'bun.lock',
  'tsconfig.json',
  'biome.json',
  '.gitignore',
  '.passport.json',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'docs/VISION.md',
];
// `docs/decisions` is deliverable: a reader who cannot see WHY a model was chosen, and what was
// rejected, has a listing rather than a reference. It was absent from this list for so long that
// nine records were deleted without anyone noticing they could never have shipped anyway.
const sourceTrees = [
  'packages',
  'scripts',
  'test',
  'examples',
  'contrib',
  'docs/architecture',
  'docs/decisions',
  'docs/assets',
  '.github/workflows',
];
const excludedDirectories = new Set(['node_modules', 'dist', '.git']);
const permittedExtension = /\.(?:ts|mjs|js|json|md|yml|yaml|c|plist|service|conf|sh|svg|png|jpg|jpeg)$/;
const Path = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !path.startsWith('/') &&
      !path.includes('\\') &&
      path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
  );
const Entry = z
  .object({
    path: Path,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 * 1024),
    mode: z.union([z.literal(0o644), z.literal(0o755)]),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const SourceManifest = z
  .object({
    schema: z.literal('wire-public-source/v1'),
    historyIncluded: z.literal(false),
    publicationAuthorized: z.literal(false),
    files: z.array(Entry).min(1).max(10000),
  })
  .strict()
  .refine(
    (value) => new Set(value.files.map((entry) => entry.path)).size === value.files.length,
    'duplicate source path',
  );
export type SourceManifest = z.infer<typeof SourceManifest>;

function permitted(path: string): boolean {
  if (rootFiles.includes(path)) return true;
  return (
    sourceTrees.some((tree) => path.startsWith(`${tree}/`)) &&
    permittedExtension.test(path) &&
    path.split('/').every((part) => !part.startsWith('.') || part === '.github') &&
    !path.split('/').some((part) => excludedDirectories.has(part))
  );
}

async function selectedFiles(root: string): Promise<string[]> {
  const files = [...rootFiles];
  async function visit(path: string): Promise<void> {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error('Source symlink is not publishable');
    if (info.isDirectory()) {
      for (const name of (await readdir(join(root, path))).sort()) {
        if (excludedDirectories.has(name)) continue;
        await visit(`${path}/${name}`);
      }
    } else {
      if (!info.isFile() || !permitted(path)) throw new Error('Unreviewed source file kind or name');
      files.push(path);
    }
  }
  for (const tree of sourceTrees) await visit(tree);
  return files.sort();
}

async function describe(root: string, path: string): Promise<z.infer<typeof Entry>> {
  let parent = root;
  for (const part of path.split('/').slice(0, -1)) {
    parent = join(parent, part);
    if ((await lstat(parent)).isSymbolicLink()) throw new Error('Source parent is a symlink');
  }
  const full = join(root, path);
  const info = await lstat(full);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
    throw new Error('Unreviewed source file size or link');
  await assertArtifactPrivacy(full);
  return Entry.parse({
    path,
    bytes: info.size,
    mode: info.mode & 0o111 ? 0o755 : 0o644,
    sha256: sha256(await Bun.file(full).bytes()),
  });
}

export async function preparePublicSource(
  rootInput: string,
  destinationInput: string,
): Promise<SourceManifest> {
  const root = await realpath(rootInput);
  const destination = join(await realpath(dirname(resolve(destinationInput))), basename(destinationInput));
  if (destination === root || root.startsWith(`${destination}/`) || destination.startsWith(`${root}/`))
    throw new Error('Source and destination trees must be disjoint');
  // Exclusive creation protects both existing snapshots and arbitrary caller-selected directories.
  await mkdir(destination, { mode: 0o700 });
  try {
    const files = [];
    for (const path of await selectedFiles(root)) {
      const entry = await describe(root, path);
      const target = join(destination, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await copyFile(join(root, path), target);
      await chmod(target, entry.mode);
      const copied = await describe(destination, path);
      if (copied.sha256 !== entry.sha256 || copied.bytes !== entry.bytes)
        throw new Error('Source changed during snapshot');
      files.push(entry);
    }
    const manifest = SourceManifest.parse({
      schema: 'wire-public-source/v1',
      historyIncluded: false,
      publicationAuthorized: false,
      files,
    });
    await Bun.write(join(destination, 'SOURCE_MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

/** Validate an untouched snapshot before running installs or builds inside it. */
export async function verifyPublicSource(root: string): Promise<SourceManifest> {
  await describe(root, 'SOURCE_MANIFEST.json');
  const manifest = SourceManifest.parse(await Bun.file(join(root, 'SOURCE_MANIFEST.json')).json());
  const actual: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(join(root, directory))) {
      const path = directory ? `${directory}/${name}` : name;
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error('Snapshot contains a symlink');
      if (info.isDirectory()) {
        if (
          path.split('/').some((part) => excludedDirectories.has(part)) ||
          !sourceTrees.some(
            (tree) => tree === path || tree.startsWith(`${path}/`) || path.startsWith(`${tree}/`),
          )
        )
          throw new Error('Snapshot contains a non-product directory');
        await visit(path);
      } else if (path !== 'SOURCE_MANIFEST.json') actual.push(path);
    }
  }
  await visit('');
  if (JSON.stringify(actual.sort()) !== JSON.stringify(manifest.files.map((file) => file.path).sort()))
    throw new Error('Snapshot file inventory differs');
  for (const entry of manifest.files) {
    if (!permitted(entry.path)) throw new Error('Snapshot contains a non-product path');
    const actual = await describe(root, entry.path);
    if (actual.sha256 !== entry.sha256 || actual.bytes !== entry.bytes || actual.mode !== entry.mode)
      throw new Error('Snapshot file integrity differs');
  }
  return manifest;
}

if (import.meta.main) {
  const [mode, directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || (mode !== '--out' && mode !== '--verify'))
    throw new Error('usage: public-source --out <new-directory> | --verify <snapshot>');
  const manifest =
    mode === '--out'
      ? await preparePublicSource(resolve(import.meta.dir, '..'), directory)
      : await verifyPublicSource(resolve(directory));
  console.log(
    JSON.stringify({ sourceFiles: manifest.files.length, historyIncluded: false, publicClearance: false }),
  );
}
