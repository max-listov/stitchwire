import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectConfig } from '../packages/runtime/src/config/inspect.ts';
import { fleetSigner } from './signed-fleet.ts';

test('inspection reads the configured retained copy and returns credential digests only', () => {
  const root = mkdtempSync('/tmp/config-inspection-'),
    path = join(root, 'config/node.json'),
    copy = join(root, 'elsewhere/policy.json');
  try {
    mkdirSync(join(root, 'config'));
    mkdirSync(join(root, 'elsewhere'));
    const key = fleetSigner('fixture'),
      token = 'q'.repeat(40);
    const bundle = key.edition(
      { version: 1, members: { worker: { copy: 'full' } }, access: [] },
      7,
      '2026-01-01T00:00:00.000Z',
    );
    writeFileSync(copy, JSON.stringify(bundle));
    writeFileSync(
      path,
      JSON.stringify({
        nodeId: 'worker',
        brokers: [{ id: 'primary', url: 'https://example.invalid', token }],
        fleet: { copy, trust: key.trust },
      }),
    );
    const before = readFileSync(path),
      info = inspectConfig('node', path);
    expect(info.fleet).toMatchObject({ copy, serial: 7, state: 'aligned', signers: ['fixture'] });
    expect(info.brokers[0]?.tokenSha256).toBe(new Bun.CryptoHasher('sha256').update(token).digest('hex'));
    expect(JSON.stringify(info)).not.toContain(token);
    expect(readFileSync(path)).toEqual(before);
    writeFileSync(copy, '{}');
    expect(inspectConfig('node', path).fleet).toMatchObject({ state: 'unknown', serial: null });
    expect(readFileSync(path)).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
