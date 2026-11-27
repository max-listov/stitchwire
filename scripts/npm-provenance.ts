import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonBytes } from 'stitchkit/files';
import { readBoundedBody } from 'stitchkit/http';
import { z } from 'zod';
import { runBounded, saidLast } from './bounded-command.ts';
import type { ReleasePackage } from './npm-release.ts';

const registry = 'https://registry.npmjs.org';
const predicateType = 'https://slsa.dev/provenance/v1';
const metadata = z.object({
  name: z.string(),
  version: z.string(),
  _npmUser: z.object({ trustedPublisher: z.object({ id: z.literal('github') }) }),
  dist: z.object({ integrity: z.string(), attestations: z.object({ url: z.url() }) }),
});
const attestations = z.object({
  attestations: z.array(
    z.object({
      predicateType: z.string(),
      bundle: z.object({ dsseEnvelope: z.object({ payload: z.string() }) }),
    }),
  ),
});
const statement = z.object({
  _type: z.literal('https://in-toto.io/Statement/v1'),
  predicateType: z.literal(predicateType),
  subject: z.array(z.object({ name: z.string(), digest: z.object({ sha512: z.string() }) })).length(1),
  predicate: z.object({
    buildDefinition: z.object({
      externalParameters: z.object({
        workflow: z.object({ ref: z.string(), repository: z.string(), path: z.string() }),
      }),
      resolvedDependencies: z.array(
        z.object({ uri: z.string(), digest: z.object({ gitCommit: z.string() }) }),
      ),
    }),
    runDetails: z.object({
      builder: z.object({ id: z.string() }),
      metadata: z.object({ invocationId: z.url() }),
    }),
  }),
});
export type Source = { slug: string; tag: string; sha: string };

async function publicJson(url: string): Promise<unknown> {
  const signal = AbortSignal.timeout(30_000);
  const response = await fetch(url, { redirect: 'error', signal });
  if (!response.ok) throw new Error(`npm provenance HTTP ${response.status} at ${url}`);
  return parseJsonBytes(
    await readBoundedBody(response.body, {
      maxBytes: 4 * 1024 * 1024,
      signal,
      limitError: () => new Error('oversized npm provenance'),
    }),
  );
}

/** Bind the npm-verified statement to these bytes and to the exact tag checkout. */
export function assertPublisherStatement(
  data: unknown,
  pkg: { name: string; version: string },
  sha512: string,
  source: Source,
): string {
  const proof = statement.parse(data);
  const repo = `https://github.com/${source.slug}`,
    ref = `refs/tags/${source.tag}`;
  const { buildDefinition: build, runDetails: run } = proof.predicate;
  const workflow = build.externalParameters.workflow;
  const subject = proof.subject[0];
  const purl = `pkg:npm/${pkg.name.replace('@', '%40')}@${pkg.version}`;
  const prefix = `${repo}/actions/runs/`;
  if (
    subject?.name !== purl ||
    subject.digest.sha512 !== sha512 ||
    workflow.repository !== repo ||
    workflow.ref !== ref ||
    workflow.path !== '.github/workflows/release.yml' ||
    !build.resolvedDependencies.some(
      (entry) => entry.uri === `git+${repo}@${ref}` && entry.digest.gitCommit === source.sha,
    ) ||
    run.builder.id !== 'https://github.com/actions/runner/github-hosted' ||
    !run.metadata.invocationId.startsWith(prefix) ||
    !/^\d+\/attempts\/\d+$/.test(run.metadata.invocationId.slice(prefix.length))
  )
    throw new Error(
      `npm provenance does not bind ${pkg.name}@${pkg.version} to its archive and release workflow`,
    );
  return run.metadata.invocationId;
}

async function checkIdentity(pkg: ReleasePackage, source: Source): Promise<string> {
  const id = `${pkg.name}@${pkg.version}`;
  const meta = metadata.parse(await publicJson(`${registry}/${encodeURIComponent(pkg.name)}/${pkg.version}`));
  const digest = createHash('sha512')
    .update(await Bun.file(pkg.path).bytes())
    .digest();
  const url = new URL(meta.dist.attestations.url);
  if (
    meta.name !== pkg.name ||
    meta.version !== pkg.version ||
    meta.dist.integrity !== `sha512-${digest.toString('base64')}` ||
    url.origin !== registry ||
    url.username ||
    url.password ||
    decodeURIComponent(url.pathname) !== `/-/npm/v1/attestations/${id}`
  )
    throw new Error(`unexpected npm provenance identity for ${id}`);
  const entries = attestations
    .parse(await publicJson(url.href))
    .attestations.filter((entry) => entry.predicateType === predicateType);
  if (entries.length !== 1 || !entries[0]) throw new Error(`expected one npm provenance statement for ${id}`);
  const payload = parseJsonBytes(Buffer.from(entries[0].bundle.dsseEnvelope.payload, 'base64'));
  return assertPublisherStatement(payload, pkg, digest.toString('hex'), source);
}

export async function verifyNpmProvenance(packages: ReleasePackage[], source: Source): Promise<void> {
  if (packages.length === 0) return;
  const scratch = mkdtempSync(join(tmpdir(), 'wire-npm-signatures-'));
  try {
    writeFileSync(
      join(scratch, 'package.json'),
      JSON.stringify({ name: 'signature-check', version: '0.0.0', private: true }),
    );
    const ids = packages.map((pkg) => `${pkg.name}@${pkg.version}`);
    // Install only the release subjects. Peer product signatures belong to their own releases.
    for (const args of [
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--legacy-peer-deps',
        '--save-exact',
        ...ids,
      ],
      ['audit', 'signatures'],
    ]) {
      const result = await runBounded('npm', [...args, '--registry', registry], {
        cwd: scratch,
        timeoutMs: 180_000,
      });
      if (result.exitCode !== 0)
        throw new Error(`npm ${args[0]} failed: ${saidLast(result.stdout)} ${saidLast(result.stderr)}`);
    }
    for (const pkg of packages)
      console.log(`${pkg.name}@${pkg.version} provenance ${await checkIdentity(pkg, source)}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
