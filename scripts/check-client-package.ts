import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import manifest from '../packages/client/package.json' with { type: 'json' };
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { enrollmentStand } from '../test/enrollment-stand.ts';
import { CLIENT_PACKAGE_STAGE } from './build-client.ts';
import { assertContractsComposition, assertMainComposition } from './client-package/composition.ts';
import { proveDoorVersion, proveRuntimes } from './client-package/consumer-runtimes.ts';
import { proveConsumerTypes } from './client-package/consumer-types.ts';
import { proveEnrollment } from './client-package/enrollment-proof.ts';
import { installPacked } from './client-package/installed.ts';
import { fixtures, root, run } from './client-package/run.ts';

const artifacts = join(root, 'dist/client');
await mkdir(artifacts, { recursive: true });
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--archive'))
  throw new Error('usage: check-client-package [--archive <downloaded-tarball>]');
const archive = args[1] ? resolve(args[1]) : join(artifacts, `stitchwire-client-${manifest.version}.tgz`);

/** Install the packed client next to a consumer that owns these peer versions and exercise it there. */
async function prove(stitchkitVersion: string, zodVersion: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'wire-package-check-'));
  try {
    const installed = await installPacked(scratch, archive, stitchkitVersion, zodVersion);
    await proveDoorVersion(scratch);
    await proveConsumerTypes(scratch);
    await proveRuntimes(scratch);
    assertMainComposition(installed);
    assertContractsComposition(installed);
    await copyFile(join(fixtures, 'client-enrollment.mjs'), join(scratch, 'client-enrollment.mjs'));
    for (const runtime of ['bun', 'node']) await proveEnrollment(stand, runtime, scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const floor = /^>=(\d+\.\d+\.\d+) <1$/.exec(manifest.peerDependencies.stitchkit)?.[1];
if (floor === undefined) throw new Error('The client declares stitchkit as a peer from a floor up to <1');
const zodFloor = /^\^(\d+\.\d+\.\d+)$/.exec(manifest.peerDependencies.zod)?.[1];
if (zodFloor === undefined)
  throw new Error('The client declares zod as a peer as a caret range of one version');
// The ranges are a promise, and Bun does not enforce them: the packed client is exercised on the
// lowest versions it claims and on the ones this release is built and tested with.
const versions: Array<[stitchkit: string, zod: string]> = [
  [floor, zodFloor],
  [manifest.devDependencies.stitchkit, manifest.devDependencies.zod],
];
if (!args[1]) {
  await run(['bun', 'run', 'build:client'], root);
  await run(
    ['bun', 'pm', 'pack', '--ignore-scripts', '--filename', archive],
    join(root, CLIENT_PACKAGE_STAGE),
  );
}
// One real broker with a signed fleet copy answers every packed consumer's admission plan.
const stand = await enrollmentStand();
try {
  for (const [stitchkit, zod] of versions) {
    console.log(`packed client with stitchkit ${stitchkit}, zod ${zod}`);
    await prove(stitchkit, zod);
  }
} finally {
  await stand.stop();
}
const digest = sha256(await Bun.file(archive).bytes());
if (!args[1])
  await Bun.write(join(artifacts, 'SHA256SUMS'), `${digest}  stitchwire-client-${manifest.version}.tgz\n`);
console.log(JSON.stringify({ archive, sha256: digest, typecheck: true, isolatedInstall: true }));
