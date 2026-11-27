import { join } from 'node:path';
import { parseJsonBytes } from 'stitchkit/files';
import { readBoundedBody } from 'stitchkit/http';
import { z } from 'zod';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { runBounded, saidLast } from './bounded-command.ts';
import { verifyReleaseSet } from './candidate-manifest.ts';

const registry = 'https://registry.npmjs.org';
const packageManifest = z.object({
  name: z.string(),
  version: z.string(),
  private: z.literal(false).optional(),
  publishConfig: z.strictObject({ access: z.literal('public') }),
});
const registryManifest = z.object({
  name: z.string(),
  version: z.string(),
  dist: z.object({ tarball: z.url() }),
});
export type ReleasePackage = { name: string; version: string; path: string; bytes: number; digest: string };

export async function releasePackages(
  release: ReturnType<typeof verifyReleaseSet>,
): Promise<ReleasePackage[]> {
  if (release.manifest.schema < 3) throw new Error('npm publication needs both sealed package archives');
  const packages: ReleasePackage[] = [];
  for (const file of release.manifest.files) {
    if (file.role !== 'runtime-package' && file.role !== 'client') continue;
    const sdk = file.role === 'client';
    const name = sdk ? release.manifest.client.package : 'stitchwire';
    const version = sdk ? release.manifest.client.version : release.manifest.candidate.version;
    const path = join(release.directory, file.file);
    const contents = await Bun.file(path).bytes();
    if (sha256(contents) !== file.sha256) throw new Error(`sealed archive changed: ${file.file}`);
    const archive = await new Bun.Archive(contents).files();
    const packed = archive.get('package/package.json');
    if (!packed || packed.size > 1024 * 1024) throw new Error(`missing or oversized manifest: ${file.file}`);
    const declared = packageManifest.parse(await packed.json());
    if (declared.name !== name || declared.version !== version)
      throw new Error(`archive must declare ${name}@${version}: ${file.file}`);
    packages.push({ name, version, path, bytes: file.bytes, digest: file.sha256 });
  }
  return packages;
}

/** An anonymous read verifies the bytes a new user can actually install. */
export async function registryHasArchive(
  pkg: ReleasePackage,
  get: (url: string, options: RequestInit) => Promise<Response> = fetch,
): Promise<boolean> {
  const id = `${pkg.name}@${pkg.version}`;
  // Bound both requests together so an unavailable registry cannot hold the release indefinitely.
  const options = { redirect: 'error', signal: AbortSignal.timeout(45_000) } as const;
  const limitError = () => new Error(`registry response exceeds its expected size for ${id}`);
  const response = await get(`${registry}/${encodeURIComponent(pkg.name)}/${pkg.version}`, options);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`cannot read ${id}: registry HTTP ${response.status}`);
  const meta = registryManifest.parse(
    parseJsonBytes(
      await readBoundedBody(response.body, { maxBytes: 1024 * 1024, signal: options.signal, limitError }),
    ),
  );
  const url = new URL(meta.dist.tarball);
  if (
    meta.name !== pkg.name ||
    meta.version !== pkg.version ||
    url.origin !== registry ||
    url.username ||
    url.password
  )
    throw new Error(`unexpected registry identity or tarball location for ${id}`);
  const archive = await get(url.href, options);
  if (!archive.ok) throw new Error(`cannot download ${id}: registry HTTP ${archive.status}`);
  const bytes = await readBoundedBody(archive.body, {
    maxBytes: pkg.bytes,
    signal: options.signal,
    limitError,
  });
  if (bytes.length !== pkg.bytes || sha256(bytes) !== pkg.digest)
    throw new Error(`${id} already exists with different bytes`);
  return true;
}

export async function publishPackages(packages: ReleasePackage[], verifyOnly: boolean): Promise<void> {
  // Check both existing identities before creating either one. A retry can finish a partial pair.
  const present = await Promise.all(packages.map((pkg) => registryHasArchive(pkg)));
  for (const [index, pkg] of packages.entries()) {
    if (present[index]) continue;
    if (verifyOnly) throw new Error(`npm lacks ${pkg.name}@${pkg.version}`);
    if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL)
      throw new Error('new npm versions must be published by the trusted release workflow');
    const args = [
      'publish',
      pkg.path,
      '--access',
      'public',
      '--registry',
      registry,
      '--ignore-scripts',
      '--provenance',
    ];
    if (sha256(await Bun.file(pkg.path).bytes()) !== pkg.digest)
      throw new Error(`archive changed: ${pkg.path}`);
    const result = await runBounded('npm', args, { timeoutMs: 180_000 });
    if (result.exitCode !== 0 && !(await registryHasArchive(pkg)))
      throw new Error(
        `npm publish ${pkg.name}@${pkg.version} exited ${result.exitCode}: ${saidLast(result.stderr)}`,
      );
    // The write and its anonymous read can hit different registry replicas.
    let visible = false;
    for (let attempt = 0; attempt < 10 && !visible; attempt++) {
      if (attempt > 0) await Bun.sleep(2000);
      visible = await registryHasArchive(pkg);
    }
    if (!visible) throw new Error(`npm has not served the published ${pkg.name}@${pkg.version}`);
  }
}

if (import.meta.main) {
  const [directory, mode] = process.argv.slice(2);
  if (!directory || !['--publish', '--verify-only'].includes(mode ?? ''))
    throw new Error('usage: npm-release <sealed release directory> --publish|--verify-only');
  const release = verifyReleaseSet(directory);
  if (mode === '--publish') {
    const ref = `refs/tags/v${release.manifest.candidate.version}`;
    if (
      release.manifest.schema !== 4 ||
      release.digest !== process.env.EXPECTED_MANIFEST ||
      process.env.GITHUB_ACTIONS !== 'true' ||
      process.env.GITHUB_REF !== ref ||
      process.env.GITHUB_WORKFLOW_REF !==
        `${process.env.GITHUB_REPOSITORY}/.github/workflows/release.yml@${ref}`
    )
      throw new Error(
        'npm publication requires the signed, smoke-approved manifest and its tagged release workflow',
      );
  }
  await publishPackages(await releasePackages(release), mode === '--verify-only');
}
