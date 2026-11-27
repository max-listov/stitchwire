import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import {
  CANDIDATE_LAYOUT,
  CANDIDATE_NOTICES,
  type CandidateFile,
  checksumList,
  manifestText,
  type RollbackFile,
  releaseManifest,
  rollbackManifest,
} from '../scripts/candidate-manifest.ts';
import { DARWIN_ARCHITECTURES, nativeSidecar } from '../scripts/runtime-assets.ts';

type Contents = (role: string, file: string) => string | Buffer;
const synthetic: Contents = (role) => `synthetic ${role}\n`;

/**
 * A release set as create-candidate seals it — the same manifest and checksum writers — as a map from
 * file name to bytes, so a test can serve it or write it. `contents` chooses each file's bytes.
 */
export function releaseSetFiles(version: string, contents: Contents = synthetic): Map<string, Buffer> {
  const candidate = { version, file: `stitchwire-${version}` };
  const client = {
    package: '@stitchwire/client',
    version,
    file: `stitchwire-client-${version}.tgz`,
    localDoor: 7,
  };
  type Entry = { role: CandidateFile['role']; file: string };
  const entries: Entry[] = [
    { role: 'candidate', file: candidate.file },
    { role: 'client', file: client.file },
    { role: 'runtime-package', file: `stitchwire-${version}.tgz` },
    ...CANDIDATE_NOTICES,
    ...DARWIN_ARCHITECTURES.map(
      (arch): Entry => ({ role: 'candidate-native', file: nativeSidecar(candidate.file, arch) }),
    ),
  ];
  const out = new Map<string, Buffer>();
  const files = entries.map((entry) => {
    const bytes = Buffer.from(contents(entry.role, entry.file));
    out.set(entry.file, bytes);
    return { ...entry, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = Buffer.from(manifestText(releaseManifest({ candidate, client, files })));
  out.set('manifest.json', manifest);
  out.set('SHA256SUMS', Buffer.from(checksumList(files, sha256(manifest))));
  return out;
}

function writeSet(directory: string, files: Map<string, Buffer>): void {
  mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of files) writeFileSync(join(directory, name), bytes);
}

/** A complete candidate directory: the release set and its rollback packet, as create-candidate lays them out. */
export function candidateFixture(
  root: string,
  { version = '1.2.3', previous = '1.2.2', rollback = 'synthetic rollback\n' } = {},
): void {
  const release = releaseSetFiles(version);
  writeSet(join(root, CANDIDATE_LAYOUT.release), release);
  const rollbackName = `stitchwire-${previous}.rollback`;
  const rollbackBytes = Buffer.from(rollback);
  const files: RollbackFile[] = [
    { role: 'rollback', file: rollbackName, bytes: rollbackBytes.length, sha256: sha256(rollbackBytes) },
  ];
  const releaseManifestBytes = release.get('manifest.json');
  if (releaseManifestBytes === undefined) throw new Error('the release set has no manifest');
  const manifest = Buffer.from(
    manifestText(
      rollbackManifest({
        rollback: { version: previous, file: rollbackName },
        candidate: { version, manifestSha256: sha256(releaseManifestBytes) },
        files,
      }),
    ),
  );
  writeSet(
    join(root, CANDIDATE_LAYOUT.rollback),
    new Map([
      [rollbackName, rollbackBytes],
      ['manifest.json', manifest],
      ['SHA256SUMS', Buffer.from(checksumList(files, sha256(manifest)))],
    ]),
  );
}
