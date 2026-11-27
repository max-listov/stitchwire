import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import {
  CANDIDATE_LAYOUT,
  CANDIDATE_NOTICES,
  checksumList,
  publishedAssets,
  verifyCandidate,
} from '../scripts/candidate-manifest.ts';
import { candidateFixture } from './candidate-fixture.ts';

function withCandidate(run: (root: string, release: string, rollback: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'candidate-packet-'));
  try {
    candidateFixture(root);
    run(root, join(root, CANDIDATE_LAYOUT.release), join(root, CANDIDATE_LAYOUT.rollback));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the certified packet includes immutable client, runtime assets and all license evidence', () => {
  withCandidate((root, release) => {
    const accepted = verifyCandidate(root);
    expect(accepted.release.manifest.files).toHaveLength(8);
    expect(accepted.release.listed.size).toBe(9);
    expect(accepted.release.manifest.files).toContainEqual(
      expect.objectContaining({ role: 'runtime-package', file: 'stitchwire-1.2.3.tgz' }),
    );
    for (const notice of CANDIDATE_NOTICES) {
      const path = join(release, notice.file),
        bytes = readFileSync(path);
      rmSync(path);
      expect(() => verifyCandidate(root)).toThrow();
      writeFileSync(path, 'changed notice');
      expect(() => verifyCandidate(root)).toThrow('bytes or checksum differ');
      writeFileSync(path, bytes);
      expect(verifyCandidate(root).release.digest).toBe(accepted.release.digest);
    }
    const sums = readFileSync(join(release, 'SHA256SUMS'), 'utf8');
    writeFileSync(join(release, 'SHA256SUMS'), `${sums}${sums.split('\n')[0]}\n`);
    expect(() => verifyCandidate(root)).toThrow('duplicate');
    writeFileSync(join(release, 'SHA256SUMS'), sums);
    writeFileSync(join(release, 'extra.txt'), 'unsealed');
    expect(() => verifyCandidate(root)).toThrow('inventory differs');
  });
});

test('a release publishes its release set only: no rollback file is an asset or can enter the set', () => {
  withCandidate((root, release, rollback) => {
    const packet = verifyCandidate(root);
    expect(packet.release.manifest.files.map((file) => file.role)).not.toContainEqual(
      expect.stringMatching(/rollback/),
    );
    const assets = publishedAssets(packet).map((path) => basename(path));
    expect(assets).toEqual([...packet.release.listed.keys(), 'SHA256SUMS']);
    expect(assets.filter((name) => name.includes('rollback'))).toEqual([]);
    expect(publishedAssets(packet).every((path) => path.startsWith(`${release}/`))).toBe(true);

    // Smoke and the conveyor read the rollback binary out of the same verified packet.
    expect(packet.rollback.binary).toBe(join(rollback, 'stitchwire-1.2.2.rollback'));
    expect(readFileSync(packet.rollback.binary, 'utf8')).toBe('synthetic rollback\n');
    expect(packet.rollback.manifest.rollback.version).toBe('1.2.2');

    // A rollback file listed into the release set is refused, not published.
    const manifest = JSON.parse(readFileSync(join(release, 'manifest.json'), 'utf8'));
    const smuggled = readFileSync(packet.rollback.binary);
    writeFileSync(join(release, 'stitchwire-1.2.2.rollback'), smuggled);
    const files = [
      ...manifest.files,
      {
        role: 'candidate',
        file: 'stitchwire-1.2.2.rollback',
        bytes: smuggled.length,
        sha256: sha256(smuggled),
      },
    ];
    const text = `${JSON.stringify({ ...manifest, files }, null, 2)}\n`;
    writeFileSync(join(release, 'manifest.json'), text);
    writeFileSync(join(release, 'SHA256SUMS'), checksumList(files, sha256(Buffer.from(text))));
    expect(() => verifyCandidate(root)).toThrow(
      'unexpected or duplicate candidate file: stitchwire-1.2.2.rollback',
    );
  });
});

test('a rollback packet sealed for another release set, or a candidate without one, is refused', () => {
  withCandidate((root, release, rollback) => {
    const manifestPath = join(release, 'manifest.json');
    const original = readFileSync(manifestPath);
    // Re-seal the release set with one changed byte in its manifest: the release set is valid on its own,
    // but the rollback packet names the digest of the manifest it was packed with.
    const changed = Buffer.from(original.toString().replace('"localDoor": 7', '"localDoor": 8'));
    writeFileSync(manifestPath, changed);
    const sums = readFileSync(join(release, 'SHA256SUMS'), 'utf8');
    writeFileSync(join(release, 'SHA256SUMS'), sums.replace(sha256(original), sha256(changed)));
    expect(() => verifyCandidate(root)).toThrow('sealed for another release set');

    writeFileSync(manifestPath, original);
    writeFileSync(join(release, 'SHA256SUMS'), sums);
    expect(() => verifyCandidate(root)).not.toThrow();
    rmSync(rollback, { recursive: true });
    expect(() => verifyCandidate(root)).toThrow('not release, rollback');
  });
});
