import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetSyncAck } from '../packages/contracts/src/fleet/bundle.ts';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { FleetKeeper } from '../packages/runtime/src/broker/fleet-keeper.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { fleetSigner } from './signed-fleet.ts';
import { FleetFollower, type FleetLane } from '../packages/runtime/src/node/fleet-follower.ts';
import { until } from './support.ts';

/**
 * A reload the supervisor declines (the file it would load is refused, or it is already the one
 * loaded) leaves the old process running. That process must keep reading its sources and asking its
 * brokers: a follower that stopped at the first reload request would sit on a stale edition and an
 * unanswered question until someone restarted it.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-fleet-reload-refusal-'));
const POLL_MS = 200;
const key = fleetSigner('signer');
let follower: FleetFollower | undefined;
let keeper: FleetKeeper | undefined;
afterAll(() => {
  follower?.stop();
  keeper?.stop();
  rmSync(root, { recursive: true, force: true });
});

test('a declined reload does not stop the follower from polling and asking again', async () => {
  const configPath = join(root, 'node.json');
  const copy = join(root, 'bundle.json');
  const base = {
    nodeId: 'reader',
    brokers: [{ id: 'primary', url: 'http://127.0.0.1:1', token: 't'.repeat(40) }],
    fleet: { trust: key.trust, copy, pollMs: POLL_MS },
  };
  writeFileSync(configPath, JSON.stringify(base), { mode: 0o600 });
  const manifest = FleetManifestSchema.parse({
    version: 1,
    members: { reader: { copy: 'own' }, peer: { copy: 'own' } },
    access: [],
    topics: { 'example.data': { producer: 'reader', subscribers: ['peer'], delivery: 'ordered' } },
  });
  // The kept edition projects tables the running configuration does not carry, so a reload is due.
  writeFileSync(copy, JSON.stringify(key.edition(manifest, 1, '2026-10-20T00:00:00.000Z')), { mode: 0o600 });
  const asked: number[] = [];
  const lane: FleetLane = {
    connected: true,
    async syncFleet(): Promise<FleetSyncAck | null> {
      asked.push(asked.length);
      return null;
    },
    publishFleet: async () => null,
  };
  let reloads = 0;
  // Settles without restarting anything: the supervisor declined, the process keeps running.
  const declined = async (): Promise<void> => {
    reloads += 1;
  };
  follower = new FleetFollower(
    'reader',
    NodeConfigSchema.parse(base).fleet,
    NodeConfigSchema.parse(base),
    configPath,
    declined,
  );
  follower.attach('primary', lane);
  follower.start();
  follower.laneChanged('primary');

  expect(await until(() => reloads >= 1)).toBe(true);
  const askedAtRequest = asked.length;
  // The unanswered sync is retried by the poll, which must still be running after the request.
  expect(await until(() => asked.length > askedAtRequest, 15_000)).toBe(true);
}, 30_000);

test('a broker whose reload was declined still adopts a newer edition', async () => {
  const configPath = join(root, 'broker.json');
  const copy = join(root, 'broker-bundle.json');
  const base = {
    nodes: [
      { id: 'reader', tokenSha256s: [sha256('r'.repeat(40))] },
      { id: 'peer', tokenSha256s: [sha256('p'.repeat(40))] },
    ],
    fleet: { trust: key.trust, copy, pollMs: POLL_MS },
  };
  writeFileSync(configPath, JSON.stringify(base), { mode: 0o600 });
  const edition = (serial: number) =>
    key.edition(
      {
        version: 1,
        members: { reader: { copy: 'full' }, peer: { copy: 'own' } },
        access: [],
        topics: {
          [`example.edition${serial}`]: { producer: 'reader', subscribers: ['peer'], delivery: 'ordered' },
        },
      },
      serial,
      '2026-10-20T00:00:00.000Z',
    );
  writeFileSync(copy, JSON.stringify(edition(1)), { mode: 0o600 });
  let reloads = 0;
  const declined = async (): Promise<void> => {
    reloads += 1;
  };
  const offered: number[] = [];
  const config = BrokerConfigSchema.parse(base);
  keeper = new FleetKeeper(
    config.fleet,
    config,
    configPath,
    declined,
    () => {},
    (serial) => offered.push(serial),
  );
  keeper.start();
  expect(await until(() => reloads >= 1)).toBe(true);
  // A newer edition lands after the request: the keeper must still read the copy and keep it.
  writeFileSync(copy, JSON.stringify(edition(2)), { mode: 0o600 });
  expect(await until(() => offered.includes(2), 10_000)).toBe(true);
}, 30_000);
