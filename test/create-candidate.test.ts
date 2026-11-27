import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CANDIDATE_LAYOUT, publishedAssets, verifyCandidate } from '../scripts/candidate-manifest.ts';
import { createCandidate } from '../scripts/create-candidate.ts';
import { DARWIN_ARCHITECTURES, nativeSidecar } from '../scripts/runtime-assets.ts';

/** An executable that answers `--version` the way a runtime does, with native sidecars beside it. */
function runtime(path: string, version: string, natives: boolean): void {
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
  chmodSync(path, 0o755);
  if (natives)
    for (const arch of DARWIN_ARCHITECTURES)
      writeFileSync(nativeSidecar(path, arch), `native ${version} ${arch}`);
}

function stand() {
  const work = mkdtempSync(join(tmpdir(), 'stitchwire-create-candidate-'));
  const inputs = join(work, 'inputs');
  mkdirSync(inputs);
  runtime(join(inputs, 'stitchwire'), '1.2.3', true);
  runtime(join(inputs, 'stitchwire-1.2.2'), '1.2.2', true);
  writeFileSync(join(inputs, 'stitchwire-client-1.2.3.tgz'), 'client archive');
  writeFileSync(join(inputs, 'stitchwire-1.2.3.tgz'), 'runtime archive');
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'dependency-inventory.json'])
    writeFileSync(join(inputs, name), `${name} text`);
  const target = join(work, 'candidates', 'v1.2.3');
  const create = () =>
    createCandidate({
      candidate: join(inputs, 'stitchwire'),
      runtimePackage: join(inputs, 'stitchwire-1.2.3.tgz'),
      baseline: join(inputs, 'stitchwire-1.2.2'),
      client: {
        path: join(inputs, 'stitchwire-client-1.2.3.tgz'),
        package: '@stitchwire/client',
        version: '1.2.3',
        localDoor: 7,
      },
      notice: (entry) => join(inputs, entry.file),
      target,
      expectedVersion: '1.2.3',
    });
  const cleanup = () => {
    // The packet is sealed read-only; a test owns it and opens it again to remove it.
    for (const directory of [target, ...Object.values(CANDIDATE_LAYOUT).map((set) => join(target, set))])
      if (existsSync(directory)) chmodSync(directory, 0o755);
    rmSync(work, { recursive: true, force: true });
  };
  return { inputs, target, create, cleanup };
}

test('a candidate seals the release set and the rollback packet apart, and publishes only the release set', async () => {
  const s = stand();
  try {
    const result = await s.create();
    expect(readdirSync(s.target).sort()).toEqual(['release', 'rollback']);
    const packet = verifyCandidate(s.target);
    expect(result).toMatchObject({
      candidateVersion: '1.2.3',
      rollbackVersion: '1.2.2',
      manifestSha256: packet.release.digest,
      rollbackManifestSha256: packet.rollback.digest,
    });

    // Nothing of the rollback is in the release manifest, its SHA256SUMS or the upload list.
    const release = join(s.target, CANDIDATE_LAYOUT.release);
    expect(readFileSync(join(release, 'manifest.json'), 'utf8')).not.toContain('rollback');
    expect(readFileSync(join(release, 'SHA256SUMS'), 'utf8')).not.toContain('rollback');
    expect(readdirSync(release).filter((name) => name.includes('rollback'))).toEqual([]);
    expect(
      publishedAssets(packet)
        .map((path) => basename(path))
        .sort(),
    ).toEqual(
      [
        'LICENSE',
        'SHA256SUMS',
        'THIRD_PARTY_NOTICES.txt',
        'dependency-inventory.json',
        'manifest.json',
        'stitchwire-1.2.3',
        'stitchwire-1.2.3.tgz',
        'stitchwire-1.2.3.darwin-arm64.node',
        'stitchwire-1.2.3.darwin-x64.node',
        'stitchwire-client-1.2.3.tgz',
      ].sort(),
    );

    // The rollback packet holds the baseline byte for byte, with its native modules, for smoke.
    expect(packet.rollback.binary).toBe(join(s.target, 'rollback', 'stitchwire-1.2.2.rollback'));
    expect(readFileSync(packet.rollback.binary)).toEqual(readFileSync(join(s.inputs, 'stitchwire-1.2.2')));
    expect(readdirSync(join(s.target, 'rollback')).sort()).toEqual([
      'SHA256SUMS',
      'manifest.json',
      'stitchwire-1.2.2.rollback',
      'stitchwire-1.2.2.rollback.darwin-arm64.node',
      'stitchwire-1.2.2.rollback.darwin-x64.node',
    ]);
    expect(packet.rollback.manifest.candidate).toEqual({
      version: '1.2.3',
      manifestSha256: packet.release.digest,
    });

    // Immutable output: a second run refuses and leaves the sealed packet as it was.
    await expect(s.create()).rejects.toThrow('immutable output is never overwritten');
    expect(verifyCandidate(s.target).release.digest).toBe(packet.release.digest);
    expect(readdirSync(join(s.target, '..'))).toEqual(['v1.2.3']);
  } finally {
    s.cleanup();
  }
});

test('a baseline without native modules is packed as it was released; a refused run leaves nothing', async () => {
  const s = stand();
  try {
    for (const arch of DARWIN_ARCHITECTURES) rmSync(nativeSidecar(join(s.inputs, 'stitchwire-1.2.2'), arch));
    await s.create();
    expect(readdirSync(join(s.target, 'rollback')).sort()).toEqual([
      'SHA256SUMS',
      'manifest.json',
      'stitchwire-1.2.2.rollback',
    ]);
    s.cleanup();

    const t = stand();
    try {
      rmSync(nativeSidecar(join(t.inputs, 'stitchwire'), 'x64'));
      await expect(t.create()).rejects.toThrow('Missing native runtime asset: stitchwire.darwin-x64.node');
      // The staging directory is removed even though its sets were being sealed read-only.
      expect(readdirSync(join(t.target, '..'))).toEqual([]);
    } finally {
      t.cleanup();
    }
  } finally {
    s.cleanup();
  }
});
