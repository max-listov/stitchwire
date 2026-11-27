import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { openBundle, reduceBundle } from '../packages/runtime/src/fleet/bundle.ts';
import { fleetSigner } from './signed-fleet.ts';
import { updateConfig } from '../packages/runtime/src/config/update.ts';

test('trust mutation verifies actual own-copy signatures and key material before writing', async () => {
  const root = mkdtempSync('/tmp/wire-trust-transaction-');
  try {
    const first = fleetSigner('key'),
      second = fleetSigner('key');
    const trust = first.trust,
      changed = second.trust;
    const manifest = FleetManifestSchema.parse({
      version: 1,
      members: { worker: { copy: 'own' } },
      access: [],
    });
    const full = first.edition(manifest, 1);
    const opening = openBundle(full, trust, { requireFull: true });
    if (!opening.ok) throw new Error(opening.detail);
    const copy = join(root, 'bundle.json'),
      path = join(root, 'node.json');
    writeFileSync(copy, JSON.stringify(reduceBundle(opening.opened, 'worker')));
    writeFileSync(
      path,
      JSON.stringify({
        nodeId: 'worker',
        brokers: [{ id: 'primary', url: 'http://127.0.0.1:9999', token: 'x'.repeat(40) }],
        fleet: { trust, copy },
      }),
    );
    const before = readFileSync(path, 'utf8');
    await expect(updateConfig('node', path, { operation: 'trust', trust: changed })).rejects.toThrow(
      'proposed trust rejects',
    );
    expect(readFileSync(path, 'utf8')).toBe(before);
    await expect(
      updateConfig('node', path, {
        operation: 'trust',
        trust: [{ id: 'other', publicKey: second.publicKey }],
      }),
    ).rejects.toThrow('proposed trust rejects');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect((await updateConfig('node', path, { operation: 'trust', trust }, true)).state).toBe('checked');
    expect(readFileSync(path, 'utf8')).toBe(before);
    writeFileSync(copy, JSON.stringify(second.edition(manifest, 2)));
    expect((await updateConfig('node', path, { operation: 'trust', trust: changed })).state).toBe('written');
    expect(JSON.parse(readFileSync(path, 'utf8')).fleet.trust).toEqual(changed);
    writeFileSync(copy, 'not-json');
    await expect(updateConfig('node', path, { operation: 'trust', trust: changed })).rejects.toThrow(
      'retained fleet bundle is invalid',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
