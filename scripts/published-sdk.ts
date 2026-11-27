import { parseJsonBytes } from 'stitchkit/files';
import { z } from 'zod';
import { runBounded, saidLast } from './bounded-command.ts';

const ReleasesSchema = z
  .array(
    z.array(
      z.object({
        tag_name: z.string().min(1),
        draft: z.boolean().optional(),
        assets: z.array(z.object({ name: z.string().min(1) })),
      }),
    ),
  )
  .min(1);

export type PublishedRelease = z.infer<typeof ReleasesSchema>[number][number];

/** Every page of a release catalog as one list; a catalog of another shape is no catalog. */
export function releasesOf(catalog: unknown): PublishedRelease[] {
  return ReleasesSchema.parse(catalog).flat();
}

export async function publishedReleases(slug: string): Promise<PublishedRelease[]> {
  const result = await runBounded(
    'gh',
    ['api', '--paginate', '--slurp', `repos/${slug}/releases?per_page=100`],
    { maxOutputBytes: 16 * 1024 * 1024 },
  );
  if (result.exitCode !== 0)
    throw new Error(
      `cannot read the complete published release catalog: gh exited ${result.exitCode}: ${saidLast(result.stderr)}`,
    );
  return releasesOf(parseJsonBytes(result.stdout));
}

/** Unknown history is a refusal. Only a successfully downloaded identical SDK can share a version. */
export async function assertPublishedSdkIdentity(
  tag: string,
  listed: ReadonlyMap<string, string>,
  releases: readonly PublishedRelease[],
  download: (tag: string, name: string) => Promise<{ digest: string } | { problem: string }>,
): Promise<void> {
  for (const [name, digest] of listed) {
    if (!/-\d+\.\d+\.\d+\.tgz$/.test(name)) continue;
    for (const release of releases) {
      if (release.tag_name === tag || !release.assets.some((asset) => asset.name === name)) continue;
      const previous = await download(release.tag_name, name);
      if ('problem' in previous) throw new Error(`${name} under ${release.tag_name}: ${previous.problem}`);
      if (previous.digest !== digest)
        throw new Error(
          `${name} is already published under ${release.tag_name} with different bytes; one SDK version cannot name two artifacts`,
        );
    }
  }
}
