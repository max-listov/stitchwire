import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSigningKey } from '../packages/runtime/src/fleet/signature.ts';

test('a signing key anyone else can read is refused by the mode of the file that was opened', () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-signing-key-'));
  const path = join(root, 'fleet.key');
  try {
    writeFileSync(path, 'key bytes\n', { mode: 0o600 });
    expect(readSigningKey(path)).toBe('key bytes\n');
    for (const [mode, named] of [
      [0o644, '644'],
      [0o640, '640'],
      [0o604, '604'],
    ] satisfies [number, string][]) {
      chmodSync(path, mode);
      expect(() => readSigningKey(path)).toThrow(
        `is mode ${named}; a signing key must be readable by its owner only`,
      );
    }
    // Negative control: the refusal is the mode, not the file; the same bytes owner-only are read.
    chmodSync(path, 0o400);
    expect(readSigningKey(path)).toBe('key bytes\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
