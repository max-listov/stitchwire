import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runNativeCommand } from 'stitchkit/process';
import { FleetKeeper } from '../packages/runtime/src/broker/fleet-keeper.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { openBundle, reduceBundle } from '../packages/runtime/src/fleet/bundle.ts';
import { fleetSigner } from './signed-fleet.ts';
import { FleetFollower } from '../packages/runtime/src/node/fleet-follower.ts';

const key = fleetSigner('fixture'),
  trust = key.trust;
const edition = (allow: boolean, serial = 123) =>
  key.edition(
    {
      version: 1,
      members: { alpha: { copy: 'full' }, beta: { copy: 'own' } },
      access: allow ? [{ from: 'alpha', to: 'beta', services: { 'example.catalog': ['service-read'] } }] : [],
    },
    serial,
    '2026-01-01T00:00:00.000Z',
  );

test('CLI, broker and own-copy follower refuse a different signed edition at the same serial', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-edition-'));
  const first = edition(false),
    conflict = edition(true),
    higher = edition(true, 124);
  const opening = openBundle(first, trust, { requireFull: true });
  if (!opening.ok) throw new Error(opening.detail);
  const reduced = reduceBundle(opening.opened, 'beta');
  if (reduced === null) throw new Error('fixture slice missing');
  const copy = join(root, 'copy.json'),
    source = join(root, 'source.json'),
    config = join(root, 'node.json');
  const raw = {
    nodeId: 'beta',
    brokers: [{ id: 'primary', url: 'https://broker.example.invalid', token: 'x'.repeat(40) }],
    agentSocket: join(root, 'agent.sock'),
    fleet: { trust, copy, sources: [source], pollMs: 200 },
  };
  let keeper: FleetKeeper | undefined;
  try {
    writeFileSync(config, JSON.stringify(raw));
    writeFileSync(copy, JSON.stringify(reduced));
    const cli = async (bundle: typeof first) => {
      writeFileSync(source, JSON.stringify(bundle));
      return runNativeCommand({
        executable: process.execPath,
        args: [
          resolve(import.meta.dir, '../packages/runtime/src/cli/main.ts'),
          'fleet',
          'install',
          source,
          '--config',
          config,
        ],
        envPolicy: 'ambient',
        capture: true,
        timeoutMs: 5000,
        maxOutputBytes: 65536,
      });
    };
    const before = readFileSync(copy);
    expect((await cli(first)).exitCode).toBe(0);
    expect(readFileSync(copy)).toEqual(before);
    const refused = await cli(conflict);
    expect(refused.exitCode).toBe(1);
    expect(new TextDecoder().decode(refused.stderr)).toContain('conflicts');
    expect(readFileSync(copy)).toEqual(before);
    expect((await cli(higher)).exitCode).toBe(0);
    expect(JSON.parse(readFileSync(copy, 'utf8'))).toMatchObject({ serial: 124, full: null });
    const brokerCopy = join(root, 'broker.json');
    const broker = BrokerConfigSchema.parse({
      nodes: [
        { id: 'alpha', tokenSha256s: ['1'.repeat(64)] },
        { id: 'beta', tokenSha256s: ['2'.repeat(64)] },
      ],
      fleet: { trust, copy: brokerCopy },
    });
    keeper = new FleetKeeper(
      broker.fleet,
      broker,
      undefined,
      undefined,
      () => {},
      () => {},
    );
    expect(keeper.publish('alpha', { bundle: first }).accepted).toBe(true);
    const brokerBefore = readFileSync(brokerCopy);
    expect(keeper.publish('alpha', { bundle: first }).accepted).toBe(true);
    expect(keeper.publish('alpha', { bundle: conflict })).toMatchObject({
      accepted: false,
      detail: expect.stringContaining('conflicts'),
    });
    expect(readFileSync(brokerCopy)).toEqual(brokerBefore);
    expect(keeper.publish('alpha', { bundle: higher }).accepted).toBe(true);
    for (const [offered, expected] of [
      [conflict, 123],
      [first, 123],
      [higher, 124],
    ] as const) {
      writeFileSync(copy, JSON.stringify(reduced));
      writeFileSync(source, JSON.stringify(offered));
      const node = NodeConfigSchema.parse(raw),
        follower = new FleetFollower('beta', node.fleet, node, undefined, undefined);
      try {
        follower.start();
        expect(follower.snapshot().serial).toBe(expected);
      } finally {
        follower.stop();
      }
      expect(JSON.parse(readFileSync(copy, 'utf8'))).toMatchObject({ serial: expected, full: null });
    }
  } finally {
    keeper?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
