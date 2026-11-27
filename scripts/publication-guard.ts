import { resolve } from 'node:path';
import { z } from 'zod';
import { publishableClientManifest } from './build-client.ts';
import { buildRuntimePackageManifest } from './pack-runtime-package.ts';

const SourceManifest = z.object({ name: z.string(), private: z.literal(true) });
const PublishableManifest = z
  .object({
    name: z.string(),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    license: z.literal('MIT'),
    files: z.array(z.string()).min(1),
    publishConfig: z.object({ access: z.literal('public') }),
    repository: z.object({ type: z.literal('git'), url: z.string().min(1) }),
  })
  .refine((manifest) => !('private' in manifest), 'a publishable manifest carries no private field');

const versionedClientArchive = /stitchwire-client-\d+\.\d+\.\d+\.tgz/i;
const volatileDependencyClaim = /\b(?:Stitchkit|SDK)\s*\d+\.\d+\.\d+\b/i;

/** Packed instructions must survive the next release without naming yesterday's artifact. */
export async function assertClientDocumentationCurrent(root: string): Promise<void> {
  const readme = await Bun.file(resolve(root, 'packages/client/README.md')).text();
  if (versionedClientArchive.test(readme))
    throw new Error('Client README must not pin a versioned Stitchwire archive filename');
  if (volatileDependencyClaim.test(readme))
    throw new Error('Client README must derive SDK and Stitchkit versions from package metadata');
  if (!readme.includes('bun add @stitchwire/client'))
    throw new Error('Client README must include the public package install recipe');
}

/**
 * Two packages reach npm, `@stitchwire/client` and `stitchwire`, and neither from a source manifest.
 *
 * Every manifest in the tree — the root and all four workspaces — is `private: true`, so `npm publish`
 * or `bun publish` run anywhere in the checkout refuses before it packs. The publishable manifests are
 * written by the build into `dist/`: the client by `build-client.ts`, the runtime by
 * `pack-runtime-package.ts`. This guard checks both halves from the same functions the build uses.
 */
export async function assertPublicationBoundaries(root: string): Promise<void> {
  const read = (path: string) => Bun.file(resolve(root, path)).json();
  for (const path of [
    'package.json',
    'packages/client/package.json',
    'packages/contracts/package.json',
    'packages/local-client/package.json',
    'packages/runtime/package.json',
  ])
    SourceManifest.parse(await read(path));
  const client = PublishableManifest.parse(
    publishableClientManifest(await read('packages/client/package.json')),
  );
  if (client.name !== '@stitchwire/client') throw new Error('The publishable client is @stitchwire/client');
  const runtime = PublishableManifest.parse(buildRuntimePackageManifest(await read('package.json')));
  if (runtime.name !== 'stitchwire') throw new Error('The publishable runtime is stitchwire');
  await assertClientDocumentationCurrent(root);
}

if (import.meta.main) {
  await assertPublicationBoundaries(resolve(import.meta.dir, '..'));
  if (process.argv.includes('--publish'))
    throw new Error('Use the explicit release workflow to publish; publication-guard never publishes');
  console.log(
    'publication guard: every source manifest private; @stitchwire/client and stitchwire publishable only from dist/',
  );
}
