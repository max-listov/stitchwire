#!/usr/bin/env bun
/**
 * Pack the standalone `stitchwire` runtime (broker, agent & CLI) as a publishable npm tarball.
 *
 * Reuses the exact bytes produced by `bun run build` (`dist/stitchwire` + macOS native sidecars)
 * and places them in the canonical `bin/` + `native/` layout so `bun add -g stitchwire` and
 * `bunx stitchwire` resolve `../native/darwin-<arch>.node` out of the box with zero external
 * runtime dependencies.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { assertArtifactPrivacy } from './artifact-privacy.ts';
import {
  DARWIN_ARCHITECTURES,
  installRuntimeAssets,
  nativeAssetPath,
  nativeSidecar,
} from './runtime-assets.ts';

type RootManifest = {
  version: string;
  description: string;
  license: string;
  author?: unknown;
  repository?: unknown;
  homepage?: string;
  bugs?: unknown;
  keywords?: string[];
};

/** `owner/name` of the GitHub repository a manifest declares; the one place a link target is read from. */
export function githubRepository(manifest: { repository?: unknown }): string {
  const url = (manifest.repository as { url?: unknown } | undefined)?.url;
  const slug =
    typeof url === 'string' ? /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] : undefined;
  if (slug === undefined) throw new Error('package.json repository must name a GitHub repository');
  return slug;
}

/**
 * Rewrite repository-relative media and doc links so the README renders on npmjs.org.
 *
 * They point at the release tag, not at a branch: the README of a published version stays on
 * npmjs.org for good, and a link into `main` breaks the day an asset or a document moves there.
 */
export function rewriteReadmeForNpm(markdown: string, repository: string, version: string): string {
  const raw = `https://raw.githubusercontent.com/${repository}/v${version}/`;
  const blob = `https://github.com/${repository}/blob/v${version}/`;
  const tree = `https://github.com/${repository}/tree/v${version}/`;
  const local =
    /(?:\.\/)?((?:docs|examples|contrib|packages)\/[^)"\s]*|LICENSE|SECURITY\.md|CONTRIBUTING\.md|CHANGELOG\.md)/;
  const target = (path: string) => `${path.endsWith('/') ? tree : blob}${path}`;
  return markdown
    .replace(/src="(?:\.\/)?(docs\/assets\/[^"]+)"/g, `src="${raw}$1"`)
    .replace(new RegExp(`href="${local.source}"`, 'g'), (_match, path: string) => `href="${target(path)}"`)
    .replace(new RegExp(`\\]\\(${local.source}\\)`, 'g'), (_match, path: string) => `](${target(path)})`);
}

export function buildRuntimePackageManifest(rootManifest: RootManifest): Record<string, unknown> {
  return {
    name: 'stitchwire',
    version: rootManifest.version,
    description: rootManifest.description,
    license: rootManifest.license,
    ...(rootManifest.author === undefined ? {} : { author: rootManifest.author }),
    ...(rootManifest.repository === undefined ? {} : { repository: rootManifest.repository }),
    ...(rootManifest.homepage === undefined ? {} : { homepage: rootManifest.homepage }),
    ...(rootManifest.bugs === undefined ? {} : { bugs: rootManifest.bugs }),
    ...(rootManifest.keywords === undefined ? {} : { keywords: rootManifest.keywords }),
    type: 'module',
    os: ['darwin', 'linux'],
    engines: {
      bun: '>=1.4.4',
    },
    bin: {
      stitchwire: './bin/stitchwire',
    },
    files: ['bin', 'native', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.txt'],
    publishConfig: {
      access: 'public',
    },
  };
}

export async function packRuntimePackage(
  root = resolve(import.meta.dir, '..'),
): Promise<{ archive: string; sha256: string; version: string }> {
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as RootManifest;
  const sourceBinary = join(root, 'dist/stitchwire');
  const noticesPath = join(root, 'dist/THIRD_PARTY_NOTICES.txt');
  if (!existsSync(sourceBinary)) {
    throw new Error('dist/stitchwire is missing; run `bun run build` first');
  }
  for (const arch of DARWIN_ARCHITECTURES) {
    const sidecar = nativeSidecar(sourceBinary, arch);
    if (!existsSync(sidecar)) {
      throw new Error(`Missing native sidecar ${sidecar}; run \`bun run build\` first`);
    }
  }
  if (!existsSync(noticesPath)) {
    throw new Error(
      'dist/THIRD_PARTY_NOTICES.txt is missing; run `bun scripts/dependency-inventory.ts` first',
    );
  }

  const outDir = join(root, 'dist/runtime-package');
  const stageDir = join(outDir, 'package');
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  const stagedBinary = join(stageDir, 'bin/stitchwire');
  installRuntimeAssets(sourceBinary, stagedBinary);
  chmodSync(stagedBinary, 0o755);
  await assertArtifactPrivacy(stagedBinary);
  for (const arch of DARWIN_ARCHITECTURES) {
    const nativePath = join(stageDir, nativeAssetPath(arch));
    chmodSync(nativePath, 0o644);
    await assertArtifactPrivacy(nativePath);
  }

  writeFileSync(
    join(stageDir, 'README.md'),
    rewriteReadmeForNpm(
      readFileSync(join(root, 'README.md'), 'utf8'),
      githubRepository(rootManifest),
      rootManifest.version,
    ),
  );
  copyFileSync(join(root, 'LICENSE'), join(stageDir, 'LICENSE'));
  copyFileSync(noticesPath, join(stageDir, 'THIRD_PARTY_NOTICES.txt'));
  writeFileSync(
    join(stageDir, 'package.json'),
    `${JSON.stringify(buildRuntimePackageManifest(rootManifest), null, 2)}\n`,
  );

  const archiveName = `stitchwire-${rootManifest.version}.tgz`;
  const archive = join(outDir, archiveName);
  const packed = Bun.spawnSync(['bun', 'pm', 'pack', '--ignore-scripts', '--filename', archive], {
    cwd: stageDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (packed.exitCode !== 0) {
    throw new Error(
      `bun pm pack failed (${packed.exitCode}): ${packed.stderr.toString().trim() || packed.stdout.toString().trim()}`,
    );
  }
  const digest = sha256(await Bun.file(archive).bytes());
  writeFileSync(join(outDir, 'SHA256SUMS'), `${digest}  ${archiveName}\n`);
  return { archive, sha256: digest, version: rootManifest.version };
}

if (import.meta.main) {
  const result = await packRuntimePackage();
  console.log(JSON.stringify(result));
}
