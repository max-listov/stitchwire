import { basename } from 'node:path';
import { runBounded, saidLast } from './bounded-command.ts';
import { verifyNpmProvenance, type Source } from './npm-provenance.ts';
import { registryHasArchive, type ReleasePackage } from './npm-release.ts';
import type { PublishedRelease } from './published-sdk.ts';

/** Dispatch the exact tag and wait for this run, even when another operator is publishing. */
async function dispatch(source: Source, digest: string): Promise<void> {
  const started = await runBounded('gh', [
    'workflow',
    'run',
    'release.yml',
    '--repo',
    source.slug,
    '--ref',
    source.tag,
    '-f',
    `manifest_sha256=${digest}`,
  ]);
  if (started.exitCode !== 0)
    throw new Error(`release workflow dispatch failed: ${saidLast(started.stderr)}`);
  const url = new TextDecoder().decode(started.stdout).trim();
  const prefix = `https://github.com/${source.slug}/actions/runs/`,
    id = url.slice(prefix.length);
  if (!url.startsWith(prefix) || !/^\d+$/.test(id))
    throw new Error(`missing dispatched workflow run URL: ${url}`);
  console.log(`npm publisher: ${url}`);
  const job = await runBounded(
    'gh',
    ['run', 'watch', id, '--repo', source.slug, '--interval', '5', '--exit-status'],
    { timeoutMs: 25 * 60_000 },
  );
  if (job.exitCode !== 0)
    throw new Error(`npm publication failed at ${url}: ${saidLast(job.stdout, 900)} ${saidLast(job.stderr)}`);
}

/** An independently versioned SDK retains the tag and commit of its first publication. */
function originalTag(pkg: ReleasePackage, current: string, catalog: PublishedRelease[]): string {
  const tags = catalog
    .filter(
      (release) =>
        release.draft === false &&
        /^v\d+\.\d+\.\d+$/.test(release.tag_name) &&
        release.assets.some((asset) => asset.name === basename(pkg.path)),
    )
    .map((release) => release.tag_name);
  return [current, ...tags].sort((a, b) => Bun.semver.order(a.slice(1), b.slice(1)))[0] ?? current;
}

export async function certifyNpmPublication(
  packages: ReleasePackage[],
  source: Source,
  manifestDigest: string,
  catalog: PublishedRelease[],
  write: boolean,
): Promise<void> {
  const present = await Promise.all(packages.map((pkg) => registryHasArchive(pkg)));
  const byOrigin = new Map<string, ReleasePackage[]>();
  for (const pkg of packages) {
    const tag = originalTag(pkg, source.tag, catalog);
    const siblings = byOrigin.get(tag) ?? [];
    siblings.push(pkg);
    byOrigin.set(tag, siblings);
  }
  async function verify(group: ReleasePackage[], tag: string) {
    if (group.length === 0) return;
    // The directly approved first public release has registry signatures and no workflow provenance.
    // No newer package identity can use that exception.
    if (
      tag === 'v0.58.0' &&
      group.every(
        (pkg) =>
          (pkg.name === 'stitchwire' && pkg.version === '0.58.0') ||
          (pkg.name === '@stitchwire/client' && pkg.version === '0.31.0'),
      )
    )
      return;
    if (tag === source.tag) return verifyNpmProvenance(group, source);
    const commit = await runBounded('gh', ['api', `repos/${source.slug}/commits/${tag}`, '--jq', '.sha']);
    const sha = new TextDecoder().decode(commit.stdout).trim();
    if (commit.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(sha))
      throw new Error(`cannot resolve original npm release ${tag}`);
    await verifyNpmProvenance(group, { ...source, tag, sha });
  }
  if (!present.every(Boolean)) {
    if (!write) throw new Error('npm lacks a sealed release archive');
    // Refuse an already occupied identity before creating its missing sibling on a retry.
    for (const [tag, group] of byOrigin)
      await verify(
        group.filter((pkg) => present[packages.indexOf(pkg)]),
        tag,
      );
    await dispatch(source, manifestDigest);
    for (const pkg of packages)
      if (!(await registryHasArchive(pkg))) throw new Error(`npm lacks ${pkg.name}@${pkg.version}`);
  }
  for (const [tag, group] of byOrigin) await verify(group, tag);
}
