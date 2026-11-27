#!/usr/bin/env bun
/**
 * Pack a candidate: the release set a public release carries, and beside it the private rollback
 * packet smoke runs the candidate against. Both are sealed in one staging directory and appear
 * together in one rename, so a candidate directory is either complete or absent.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import clientManifest from '../packages/client/package.json' with { type: 'json' };
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { readSigningKey } from '../packages/runtime/src/fleet/signature.ts';
import { SIGNATURE_FILE, signChecksums } from './release-signature.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';
import { assertArtifactPrivacy } from './artifact-privacy.ts';
import {
  CANDIDATE_LAYOUT,
  CANDIDATE_NOTICES,
  type CandidateFile,
  checksumList,
  manifestText,
  type RollbackFile,
  releaseManifest,
  rollbackManifest,
  verifyCandidate,
} from './candidate-manifest.ts';
import { DARWIN_ARCHITECTURES, nativeSidecar } from './runtime-assets.ts';

const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

async function artifactVersion(path: string): Promise<string> {
  // `child`, never `process`: a local binding of that name hides the global one from every reader
  // and from every search for it.
  const child = Bun.spawn([path, '--version'], { stdout: 'pipe', stderr: 'ignore' });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`version probe failed for ${basename(path)}`);
  return VersionSchema.parse(output.trim());
}

const fileSha256 = async (path: string): Promise<string> => sha256(await Bun.file(path).bytes());

/** Copy one input into a set read-only and describe it as a manifest entry. */
async function seal<Role extends string>(
  source: string,
  target: string,
  role: Role,
  mode: number,
): Promise<{ role: Role; file: string; bytes: number; sha256: string }> {
  copyFileSync(source, target);
  chmodSync(target, mode);
  return { role, file: basename(target), bytes: statSync(target).size, sha256: await fileSha256(target) };
}

/** Write a set's manifest and `SHA256SUMS`, both read-only, and return the manifest's digest. */
async function writeSeal(
  directory: string,
  text: string,
  files: ReadonlyArray<{ file: string; sha256: string }>,
) {
  const manifestPath = join(directory, 'manifest.json');
  await Bun.write(manifestPath, text);
  const digest = await fileSha256(manifestPath);
  await Bun.write(join(directory, 'SHA256SUMS'), checksumList(files, digest));
  chmodSync(manifestPath, 0o444);
  chmodSync(join(directory, 'SHA256SUMS'), 0o444);
  return digest;
}

export type CandidateInputs = {
  /** The built runtime and its native sidecars beside it. */
  candidate: string;
  /** The archive accepted through its installed CLI. */
  runtimePackage: string;
  /** The approved previous release, with its native sidecars if it had them. */
  baseline: string;
  client: { path: string; package: string; version: string; localDoor: number };
  /** Where each license evidence file is read from. */
  notice: (entry: (typeof CANDIDATE_NOTICES)[number]) => string;
  /** The candidate directory; it must not exist. */
  target: string;
  /** The version the source declares; the built runtime must report it. */
  expectedVersion: string;
  signingKey: string;
};

export async function createCandidate(inputs: CandidateInputs, publicKey?: string) {
  if (!existsSync(inputs.candidate)) throw new Error('candidate binary is missing; run bun run build first');
  if (!existsSync(inputs.client.path))
    throw new Error('client archive is missing; run bun run check:client-package first');
  if (!existsSync(inputs.runtimePackage))
    throw new Error('runtime archive is missing; run bun run check:runtime-package first');
  if (!existsSync(inputs.baseline)) throw new Error('rollback baseline binary does not exist');
  if (existsSync(inputs.target))
    throw new Error(`candidate already exists at ${inputs.target}; immutable output is never overwritten`);

  const candidateVersion = await artifactVersion(inputs.candidate);
  const rollbackVersion = await artifactVersion(inputs.baseline);
  if (candidateVersion !== inputs.expectedVersion)
    throw new Error('candidate binary version does not match source version');

  const parent = dirname(inputs.target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, `.${basename(inputs.target)}-`));
  try {
    const releaseDir = join(staging, CANDIDATE_LAYOUT.release);
    const rollbackDir = join(staging, CANDIDATE_LAYOUT.rollback);
    mkdirSync(releaseDir);
    mkdirSync(rollbackDir);

    const candidateName = `stitchwire-${candidateVersion}`;
    const rollbackName = `stitchwire-${rollbackVersion}.rollback`;
    const candidatePath = join(releaseDir, candidateName);
    const rollbackPath = join(rollbackDir, rollbackName);
    const candidateFile = await seal(inputs.candidate, candidatePath, 'candidate', 0o555);
    const rollbackFile = await seal(inputs.baseline, rollbackPath, 'rollback', 0o555);
    const releaseFiles: CandidateFile[] = [
      candidateFile,
      await seal(inputs.runtimePackage, join(releaseDir, `${candidateName}.tgz`), 'runtime-package', 0o444),
      await seal(inputs.client.path, join(releaseDir, basename(inputs.client.path)), 'client', 0o444),
    ];
    const rollbackFiles: RollbackFile[] = [rollbackFile];
    await assertArtifactPrivacy(candidatePath);
    // The rollback must remain byte-identical to its already released checksum. Its historical build
    // metadata cannot be rewritten; the privacy gate still rejects embedded credential material. That
    // metadata is why it lives in its own packet and is never published.
    await assertArtifactPrivacy(rollbackPath, true);

    for (const arch of DARWIN_ARCHITECTURES) {
      const source = nativeSidecar(inputs.candidate, arch);
      if (!existsSync(source)) throw new Error(`Missing native runtime asset: ${basename(source)}`);
      const target = nativeSidecar(candidatePath, arch);
      releaseFiles.push(await seal(source, target, 'candidate-native', 0o444));
      await assertArtifactPrivacy(target);
    }
    for (const arch of DARWIN_ARCHITECTURES) {
      const source = nativeSidecar(inputs.baseline, arch);
      // Historical rollback releases did not have native assets.
      if (!existsSync(source)) continue;
      const target = nativeSidecar(rollbackPath, arch);
      rollbackFiles.push(await seal(source, target, 'rollback-native', 0o444));
      await assertArtifactPrivacy(target);
    }
    for (const entry of CANDIDATE_NOTICES)
      releaseFiles.push(await seal(inputs.notice(entry), join(releaseDir, entry.file), entry.role, 0o444));

    const release = releaseManifest({
      candidate: { version: candidateVersion, file: candidateName },
      client: {
        package: inputs.client.package,
        version: inputs.client.version,
        file: basename(inputs.client.path),
        localDoor: inputs.client.localDoor,
      },
      files: releaseFiles,
      signed: true,
    });
    const releaseDigest = await writeSeal(releaseDir, manifestText(release), release.files);
    const signaturePath = join(releaseDir, SIGNATURE_FILE);
    await Bun.write(
      signaturePath,
      signChecksums(await Bun.file(join(releaseDir, 'SHA256SUMS')).bytes(), inputs.signingKey),
    );
    chmodSync(signaturePath, 0o444);
    const rollback = rollbackManifest({
      rollback: { version: rollbackVersion, file: rollbackName },
      candidate: { version: candidateVersion, manifestSha256: releaseDigest },
      files: rollbackFiles,
    });
    const rollbackDigest = await writeSeal(rollbackDir, manifestText(rollback), rollback.files);
    verifyCandidate(staging, publicKey);
    chmodSync(releaseDir, 0o555);
    chmodSync(rollbackDir, 0o555);
    chmodSync(staging, 0o555);
    renameSync(staging, inputs.target);
    return {
      candidate: inputs.target,
      candidateVersion,
      candidateSha256: candidateFile.sha256,
      rollbackVersion,
      rollbackSha256: rollbackFile.sha256,
      manifestSha256: releaseDigest,
      rollbackManifestSha256: rollbackDigest,
    };
  } finally {
    if (existsSync(staging)) {
      // The sealed sets are read-only; the owner must be able to remove an unfinished staging tree.
      for (const directory of [staging, ...Object.values(CANDIDATE_LAYOUT).map((set) => join(staging, set))])
        if (existsSync(directory)) chmodSync(directory, 0o755);
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    const value = index < 0 ? undefined : process.argv[index + 1];
    return value === undefined || value.startsWith('--') ? undefined : value;
  };
  const baseline = argument('--baseline');
  const signingKey = argument('--signing-key');
  if (baseline === undefined || signingKey === undefined)
    throw new Error(
      'usage: bun scripts/create-candidate.ts --baseline <approved-prior-artifact> --signing-key <private-key-file> [--out <dir>]',
    );
  const root = resolve(import.meta.dir, '..');
  const clientName = `stitchwire-client-${VersionSchema.parse(clientManifest.version)}.tgz`;
  const result = await createCandidate({
    candidate: join(root, 'dist', 'stitchwire'),
    runtimePackage: join(root, 'dist', 'runtime-package', `stitchwire-${RELEASE_VERSION}.tgz`),
    baseline,
    client: {
      path: join(root, 'dist', 'client', clientName),
      package: clientManifest.name,
      version: clientManifest.version,
      localDoor: LOCAL_API_VERSION,
    },
    notice: (entry) => (entry.role === 'license' ? join(root, entry.file) : join(root, 'dist', entry.file)),
    target: resolve(argument('--out') ?? join(root, 'dist', 'candidates', `v${RELEASE_VERSION}`)),
    expectedVersion: RELEASE_VERSION,
    signingKey: readSigningKey(signingKey),
  });
  console.log(JSON.stringify(result));
}
