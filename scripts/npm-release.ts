import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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

type RegistryFetch = (url: string, options: RequestInit) => Promise<Response>;
type ArchiveState = 'missing' | 'metadata-only' | 'verified';

/** An anonymous read verifies the bytes a new user can actually install. */
async function readRegistryArchive(
  pkg: ReleasePackage,
  get: RegistryFetch,
  signal: AbortSignal,
): Promise<ArchiveState> {
  const id = `${pkg.name}@${pkg.version}`;
  // Bound both requests together so an unavailable registry cannot hold the release indefinitely.
  const options = { redirect: 'error', signal } as const;
  const limitError = () => new Error(`registry response exceeds its expected size for ${id}`);
  const response = await get(`${registry}/${encodeURIComponent(pkg.name)}/${pkg.version}`, options);
  if (response.status === 404) return 'missing';
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
  if (archive.status === 404) return 'metadata-only';
  if (!archive.ok) throw new Error(`cannot download ${id}: registry HTTP ${archive.status}`);
  const bytes = await readBoundedBody(archive.body, {
    maxBytes: pkg.bytes,
    signal: options.signal,
    limitError,
  });
  if (bytes.length !== pkg.bytes || sha256(bytes) !== pkg.digest)
    throw new Error(`${id} already exists with different bytes`);
  return 'verified';
}

export async function registryHasArchive(pkg: ReleasePackage, get: RegistryFetch = fetch): Promise<boolean> {
  const state = await readRegistryArchive(pkg, get, AbortSignal.timeout(45_000));
  // A registered version with a missing tarball is already occupied. Never publish over it.
  if (state === 'metadata-only')
    throw new Error(`cannot download ${pkg.name}@${pkg.version}: registry HTTP 404`);
  return state === 'verified';
}

/** The read replicas can lag a successful write by minutes. Wait for the user's exact bytes. */
export async function waitForPublishedArchive(
  pkg: ReleasePackage,
  {
    get = fetch,
    signal = AbortSignal.timeout(6 * 60_000),
    pause = (s) => delay(5_000, undefined, { signal: s }),
  }: {
    get?: RegistryFetch;
    signal?: AbortSignal;
    pause?: (signal: AbortSignal) => Promise<void>;
  } = {},
): Promise<void> {
  try {
    for (;;) {
      signal.throwIfAborted();
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
      if ((await readRegistryArchive(pkg, get, attempt)) === 'verified') return;
      await pause(signal);
    }
  } catch (cause) {
    if (!signal.aborted) throw cause;
    throw new Error(
      `npm has not served the published ${pkg.name}@${pkg.version} before the visibility deadline`,
      { cause },
    );
  }
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
  }
  // Both writes precede the read barrier so replication of one package cannot delay its sibling.
  await Promise.all(
    packages.filter((_, index) => !present[index]).map((pkg) => waitForPublishedArchive(pkg)),
  );
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
