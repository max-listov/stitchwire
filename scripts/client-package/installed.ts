import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import manifest from '../../packages/client/package.json' with { type: 'json' };
import { assertArtifactPrivacy } from '../artifact-privacy.ts';
import { assertClientSupport } from '../client-support.ts';
import { installedCopies } from '../installed-copies.ts';
import { run } from './run.ts';

/**
 * Install the packed client into a consumer that owns these peer versions, and hold the installed
 * package to its identity, its peers, one copy of each peer and the privacy scan. Returns its path.
 */
export async function installPacked(
  scratch: string,
  archive: string,
  stitchkitVersion: string,
  zodVersion: string,
): Promise<string> {
  await Bun.write(
    join(scratch, 'package.json'),
    JSON.stringify({
      name: 'wire-package-proof',
      private: true,
      type: 'module',
      dependencies: { stitchkit: stitchkitVersion, zod: zodVersion },
    }),
  );
  await run(['bun', 'add', '--ignore-scripts', archive], scratch);
  const installed = join(scratch, 'node_modules/@stitchwire/client');
  assertClientSupport(await Bun.file(join(installed, 'README.md')).text(), manifest.engines);
  const installedManifest = await Bun.file(join(installed, 'package.json')).json();
  if (installedManifest.name !== manifest.name || installedManifest.version !== manifest.version)
    throw new Error('Unexpected client package identity');
  if ('private' in installedManifest) throw new Error('The packed client must be publishable');
  // The client carries nothing of its own to install: Stitchkit and Zod are the consumer's.
  if (installedManifest.dependencies !== undefined) throw new Error('Unexpected client dependencies');
  if (!(await Bun.file(join(installed, 'LICENSE')).exists()))
    throw new Error('The client package carries no LICENSE');
  if (JSON.stringify(installedManifest.peerDependencies) !== JSON.stringify(manifest.peerDependencies))
    throw new Error('Unexpected client peer dependencies');
  // A consumer that owns its Stitchkit must end up with that one copy, not a second one nested under
  // the client: two copies are two implementations in one process.
  const copies = await installedCopies(scratch, 'stitchkit');
  const [only] = copies;
  if (copies.length !== 1 || only === undefined)
    throw new Error(`Expected one installed stitchkit, found ${copies.length}: ${copies.join(', ')}`);
  // The same for Zod: the client's schemas go into Stitchkit, which needs them from one copy.
  const zodCopies = await installedCopies(scratch, 'zod');
  if (zodCopies.length !== 1)
    throw new Error(`Expected one installed zod, found ${zodCopies.length}: ${zodCopies.join(', ')}`);
  const copy = await Bun.file(join(only, 'package.json')).json();
  if (copy.version !== stitchkitVersion)
    throw new Error(`The consumer's stitchkit ${stitchkitVersion} was replaced by ${copy.version}`);
  const files = await readdir(installed, { recursive: true });
  for (const file of files) {
    if (/\.(?:js|ts|md|json)$/.test(file)) await assertArtifactPrivacy(join(installed, file));
  }
  if (
    files.some((file) =>
      /(^|\/)(?:owner-contracts|broker|agent|realtime-contract|release-version|node_modules)(\/|\.)/.test(
        file,
      ),
    )
  )
    throw new Error('Runtime files leaked into client package');
  return installed;
}
