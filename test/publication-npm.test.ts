import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { publishableClientManifest } from '../scripts/build-client.ts';
import {
  buildRuntimePackageManifest,
  githubRepository,
  rewriteReadmeForNpm,
} from '../scripts/pack-runtime-package.ts';
import { assertPublicationBoundaries } from '../scripts/publication-guard.ts';

const root = resolve(import.meta.dir, '..');
const manifests = [
  'package.json',
  'packages/client/package.json',
  'packages/contracts/package.json',
  'packages/local-client/package.json',
  'packages/runtime/package.json',
];
const read = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));

/** A copy of the five manifests and the client README, so one field can be broken at a time. */
function copyTree(change?: { path: string; edit: (manifest: Record<string, unknown>) => void }): string {
  const copy = mkdtempSync(join(tmpdir(), 'stitchwire-publication-'));
  for (const path of [...manifests, 'packages/client/README.md']) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    copyFileSync(resolve(root, path), join(copy, path));
  }
  if (change !== undefined) {
    const manifest = read(change.path);
    change.edit(manifest);
    writeFileSync(join(copy, change.path), JSON.stringify(manifest));
  }
  return copy;
}

test('every source manifest is private and the guard refuses one that is not', async () => {
  await expect(assertPublicationBoundaries(root)).resolves.toBeUndefined();
  for (const path of manifests) {
    const copy = copyTree({
      path,
      edit: (manifest) => {
        delete manifest.private;
      },
    });
    try {
      await expect(assertPublicationBoundaries(copy)).rejects.toThrow();
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  }
});

test('the publishable manifests are generated without private, with public access and the source identity', () => {
  const source = read('packages/client/package.json');
  const client = publishableClientManifest(source);
  expect(client.private).toBeUndefined();
  expect(client.scripts).toBeUndefined();
  expect(client.publishConfig).toEqual({ access: 'public' });
  expect([client.name, client.version]).toEqual([source.name, source.version]);
  expect(() => publishableClientManifest({ ...source, private: undefined })).toThrow('private: true');

  const runtime = buildRuntimePackageManifest(read('package.json'));
  expect(runtime.private).toBeUndefined();
  expect(runtime.publishConfig).toEqual({ access: 'public' });
  expect([runtime.name, runtime.version]).toEqual(['stitchwire', read('package.json').version]);
});

/**
 * The refusal is the package manager's own, asked the way a person would ask it.
 *
 * `--dry-run` and a registry nothing listens on keep the control from publishing even if the
 * manifest under test were wrong. The positive control is the generated copy: the same command
 * gets past the private check there, so the refusal above is that check and not some other failure.
 */
async function dryRunPublish(manifest: Record<string, unknown>): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'stitchwire-publish-dry-run-'));
  try {
    mkdirSync(join(directory, 'dist'));
    writeFileSync(join(directory, 'dist/index.js'), 'export {};\n');
    writeFileSync(join(directory, 'README.md'), 'probe\n');
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    const child = Bun.spawn(['bun', 'publish', '--dry-run', '--registry', 'http://127.0.0.1:9/'], {
      cwd: directory,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return `${stdout}\n${stderr}`;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('bun publish refuses every source manifest and reaches past that check only for the dist copy', async () => {
  const refusal = 'attempted to publish a private package';
  for (const path of ['packages/client/package.json', 'package.json'])
    expect(await dryRunPublish(read(path))).toContain(refusal);
  const generated = await dryRunPublish(publishableClientManifest(read('packages/client/package.json')));
  expect(generated).toContain('packed');
  expect(generated).not.toContain(refusal);
});

test('the npm README links every repository file at the release tag, directories as trees', () => {
  const repository = githubRepository(read('package.json'));
  expect(read('package.json').repository.url).toContain(`github.com/${repository}.git`);
  const readme = [
    '<img src="docs/assets/mark.jpg" />',
    '<a href="./LICENSE">',
    '[MIT](./LICENSE) · [ADRs](docs/decisions/) · [service](examples/service/README.md) · [top](#why)',
    '[external](https://example.com/docs/x.md)',
  ].join('\n');
  expect(rewriteReadmeForNpm(readme, 'owner/name', '1.2.3').split('\n')).toEqual([
    '<img src="https://raw.githubusercontent.com/owner/name/v1.2.3/docs/assets/mark.jpg" />',
    '<a href="https://github.com/owner/name/blob/v1.2.3/LICENSE">',
    '[MIT](https://github.com/owner/name/blob/v1.2.3/LICENSE) · [ADRs](https://github.com/owner/name/tree/v1.2.3/docs/decisions/) · [service](https://github.com/owner/name/blob/v1.2.3/examples/service/README.md) · [top](#why)',
    '[external](https://example.com/docs/x.md)',
  ]);
  // The real README keeps no relative link and no branch link once rewritten.
  const packed = rewriteReadmeForNpm(readFileSync(resolve(root, 'README.md'), 'utf8'), repository, '1.2.3');
  expect(packed).not.toMatch(/(?:src|href)="(?!https?:|#)|\]\((?!https?:|#)/);
  expect(packed).not.toContain(`${repository}/blob/main`);
  expect(() => githubRepository({ repository: { url: 'https://example.com/x.git' } })).toThrow('GitHub');
});
