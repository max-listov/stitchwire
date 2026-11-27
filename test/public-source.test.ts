import { expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertArtifactPrivacy } from '../scripts/artifact-privacy.ts';
import { preparePublicSource, verifyPublicSource } from '../scripts/public-source.ts';

async function fixture(run: (root: string, output: string) => Promise<void>) {
  const scratch = await mkdtemp('/tmp/wire-source-test-');
  const root = join(scratch, 'input');
  try {
    await mkdir(root);
    // Every declared source tree, deliberately. A missing one is an ENOENT rather than a silent
    // skip, and that is the behaviour worth keeping: `docs/decisions` was absent from the declared
    // list for long enough that nine records were deleted without anyone noticing they could never
    // have shipped anyway. A tree that is declared and gone should stop the snapshot.
    for (const dir of [
      'packages',
      'scripts',
      'test',
      'examples',
      'contrib/launchd',
      'contrib/systemd',
      'contrib/nginx',
      'docs/architecture',
      'docs/decisions',
      'docs/assets',
      '.github/workflows',
    ])
      await mkdir(join(root, dir), { recursive: true });
    for (const file of [
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
    ])
      await Bun.write(join(root, file), 'synthetic fixture\n');
    await Bun.write(join(root, 'packages/entry.ts'), 'export const value = 1;\n');
    await Bun.write(join(root, 'contrib/launchd/stitchwire-launcher.c'), 'int main(void) { return 0; }\n');
    await Bun.write(
      join(root, 'contrib/launchd/com.stitchwire.agent.plist'),
      '<string>/Users/USERNAME/bin</string>\n',
    );
    await Bun.write(join(root, 'docs/assets/mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    await run(root, join(scratch, 'snapshot'));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

test('public snapshot excludes private roots, history and build outputs and verifies exact bytes', async () => {
  await fixture(async (root, output) => {
    for (const path of [
      '.git/config',
      'docs/backlog/inbox/private.md',
      'dist/private.json',
      'packages/client/dist/private.json',
      'packages/client/node_modules/private.json',
      '.env',
    ])
      await Bun.write(join(root, path), 'not a publication input');
    const manifest = await preparePublicSource(root, output);
    expect(manifest.files).toHaveLength(17);
    expect(manifest.files.map((entry) => entry.path)).toContain('contrib/launchd/stitchwire-launcher.c');
    expect(manifest.files.map((entry) => entry.path)).toContain('contrib/launchd/com.stitchwire.agent.plist');
    expect(manifest.files.map((entry) => entry.path)).toContain('docs/assets/mark.svg');
    expect(await verifyPublicSource(output)).toEqual(manifest);
    expect(await Bun.file(join(output, '.env')).exists()).toBe(false);
    await expect(preparePublicSource(root, output)).rejects.toThrow();
    expect(await verifyPublicSource(output)).toEqual(manifest);
    await Bun.write(join(output, 'packages/entry.ts'), 'tampered');
    await expect(verifyPublicSource(output)).rejects.toThrow('integrity');
  });
});

test('snapshot rejects unexpected files, symlinks, private paths and credential shapes', async () => {
  for (const kind of ['symlink', 'hidden', 'secret', 'private-path', 'unknown-kind']) {
    await fixture(async (root, output) => {
      const path = join(root, 'packages/entry.ts');
      if (kind === 'symlink') {
        await rm(path);
        await symlink(join(root, 'README.md'), path);
      } else if (kind === 'hidden') await Bun.write(join(root, 'packages/.env'), 'hidden');
      else if (kind === 'unknown-kind') await Bun.write(join(root, 'packages/opaque.bin'), 'opaque');
      else
        await Bun.write(
          path,
          kind === 'secret'
            ? ['gh', 'p_', 'a'.repeat(32)].join('')
            : ['/', 'Users', '/', 'example', '/', 'private-file'].join(''),
        );
      await expect(preparePublicSource(root, output)).rejects.toThrow();
      expect(await Bun.file(join(output, 'SOURCE_MANIFEST.json')).exists()).toBe(false);
    });
  }
});

test('verification rejects injected history, changed executable permissions and forged paths', async () => {
  await fixture(async (root, output) => {
    await preparePublicSource(root, output);
    await Bun.write(join(output, '.git/config'), 'injected');
    await expect(verifyPublicSource(output)).rejects.toThrow('non-product directory');
    await rm(join(output, '.git'), { recursive: true });
    await chmod(join(output, 'packages/entry.ts'), 0o755);
    await expect(verifyPublicSource(output)).rejects.toThrow('integrity');
    await chmod(join(output, 'packages/entry.ts'), 0o644);
    const manifest = await verifyPublicSource(output);
    await Bun.write(
      join(output, 'SOURCE_MANIFEST.json'),
      JSON.stringify({
        ...manifest,
        files: [{ ...manifest.files[0], path: '../outside' }],
      }),
    );
    await expect(verifyPublicSource(output)).rejects.toThrow();
  });
});

test('source and destination cannot overlap or traverse a symlinked source parent', async () => {
  await fixture(async (root, output) => {
    await expect(preparePublicSource(root, join(root, 'snapshot'))).rejects.toThrow('disjoint');
    await rm(join(root, 'docs'), { recursive: true });
    await mkdir(output);
    // Every declared tree under `docs`, so the walk gets far enough to reach the symlinked parent
    // instead of stopping on a missing directory — the refusal under test is about the symlink.
    await mkdir(join(output, 'architecture'));
    await mkdir(join(output, 'decisions'));
    await mkdir(join(output, 'assets'));
    await Bun.write(join(output, 'VISION.md'), 'private');
    await symlink(output, join(root, 'docs'));
    await expect(preparePublicSource(root, `${output}-new`)).rejects.toThrow('symlink');
  });
});

test('the client build leaves nothing in the source tree: a stray copy there is unreviewed', async () => {
  await fixture(async (root, output) => {
    await mkdir(join(root, 'packages/client'), { recursive: true });
    await Bun.write(join(root, 'packages/client/LICENSE'), 'a leftover of an older build');
    await expect(preparePublicSource(root, output)).rejects.toThrow('Unreviewed');
  });
});

test('the launchd placeholder home is allowed only as a whole path segment', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'stitchwire-artifact-privacy-'));
  try {
    const check = async (text: string) => {
      const path = join(scratch, 'artifact.txt');
      await Bun.write(path, text);
      return assertArtifactPrivacy(path);
    };
    await expect(check('<string>/Users/USERNAME/.local/bin</string>\n')).resolves.toBeUndefined();
    await expect(check('home is /Users/USERNAME\n')).resolves.toBeUndefined();
    // Assembled at runtime: written out, these homes would stop the snapshot of this very file.
    for (const user of ['USERNAME-real', 'USERNAMES', 'someone'])
      await expect(check(`${['', 'Users', user, 'bin'].join('/')}\n`)).rejects.toThrow(
        'macOS user-home path',
      );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
