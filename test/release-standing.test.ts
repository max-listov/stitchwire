/**
 * Which build a machine carries, and how far behind it is.
 *
 * A node left on an older artifact used to read as `offline` — the same word a broken network
 * earns, needing the opposite repair. What is pinned here is the three states staying distinct, and
 * the classification erring on the alarming side rather than the reassuring one, because a person
 * reads the word and acts on it.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealtimeClient } from 'stitchkit';
import { loadLanePeer } from '../packages/runtime/src/transport/lane-peer.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { AgentHandle } from '../packages/runtime/src/node/agent-contract.ts';
import { mergePresence } from '../packages/runtime/src/node/presence.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { LocalStatusSchema } from '../packages/contracts/src/door/status.ts';
import type { Presence } from '../packages/contracts/src/protocol/presence.ts';
import {
  behindBy,
  bestKnownRelease,
  comparableVersions,
  worseBehind,
} from '../packages/contracts/src/protocol/release.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';
import { wireContract } from '../packages/contracts/src/realtime-contract.ts';
import { brokerConfig, brokerHealth, freePort, until, waitConnected } from './support.ts';

const PORT = freePort();
const DEAD_PORT = freePort(); // nothing listens: the node can never confirm anything
const TOKEN = 'r'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'stitchwire-release-'));

let broker: Awaited<ReturnType<typeof startBroker>>;
let connected: AgentHandle;
let orphan: AgentHandle;
const health = () => brokerHealth(PORT);

beforeAll(async () => {
  broker = await startBroker(
    brokerConfig({ worker: TOKEN, stale: TOKEN, 'never-seen': TOKEN }, { port: PORT }),
  );
  connected = await startAgent(
    NodeConfigSchema.parse({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token: TOKEN }],
      nodeId: 'worker',
      agentSocket: join(root, 'worker.sock'),
    }),
  );
  orphan = await startAgent(
    NodeConfigSchema.parse({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${DEAD_PORT}`, token: TOKEN }],
      nodeId: 'worker',
      agentSocket: join(root, 'orphan.sock'),
    }),
  );
  await waitConnected(connected);
});

afterAll(async () => {
  await orphan?.stop();
  await connected?.stop();
  await broker?.stop();
});

test('below 1.0.0 a minor gap is the breaking one, not a moderate one', () => {
  // Reading the positions literally would make `major` unreachable for this project's whole life
  // and file six flag days under `minor`. The error would point the reassuring way.
  expect(behindBy('0.10.0', '0.16.0')).toBe('major');
  expect(behindBy('0.16.0', '0.16.1')).toBe('patch');
  expect(behindBy('1.2.0', '1.3.0')).toBe('minor');
  expect(behindBy('1.2.0', '2.0.0')).toBe('major');
  expect(behindBy('2.0.0', '2.0.1')).toBe('patch');
});

test('level with the fleet, or ahead of it, is not behind', () => {
  expect(behindBy('0.16.0', '0.16.0')).toBeNull();
  // A development build ahead of the release is not a problem; colouring it as one teaches people
  // to ignore the colour.
  expect(behindBy('0.17.0', '0.16.0')).toBeNull();
  // Nothing to compare against is not "fine".
  expect(behindBy('0.16.0', null)).toBeNull();
});

test('the best known release is the newest anyone confirmed, not the first listed', () => {
  expect(bestKnownRelease([null, '0.9.0', '0.16.0', '0.15.1'])).toBe('0.16.0');
  expect(bestKnownRelease([null, null])).toBeNull();
});

test('a node that reached no broker says so, and is not drawn as current', async () => {
  const response = await fetch('http://localhost/wire/status', { unix: join(root, 'orphan.sock') });
  const status = LocalStatusSchema.parse(await response.json());
  const release = status.release;
  if (release === undefined) throw new Error('the door published no release standing');
  expect(release.current).toBe(RELEASE_VERSION);
  // It knows what it runs and nothing about what it should run. Those are different facts.
  expect(release.latest).toBeNull();
  expect(release.ok).toBe(false);
  expect(release.checkedAt).not.toBeNull();
});

test('a connected node confirms the fleet release by having been admitted', async () => {
  const response = await fetch('http://localhost/wire/status', { unix: join(root, 'worker.sock') });
  const status = LocalStatusSchema.parse(await response.json());
  // Being let in IS the confirmation: a broker admits its own version and refuses every other.
  expect(status.release?.latest).toBe(RELEASE_VERSION);
  expect(status.release?.ok).toBe(true);
  expect(status.release?.latestAt).toBeNull();
});

test('a node refused for its version is named with the build it brought', async () => {
  const stale = createRealtimeClient(wireContract, {
    peers: { client: loadLanePeer },
    url: `http://127.0.0.1:${PORT}`,
    auth: () => ({ nodeId: 'stale', token: TOKEN, serves: true, version: '0.9.0' }),
    withCredentials: false,
    transports: ['websocket'],
    reconnectionDelay: 50,
    reconnectionDelayMax: 50,
    onRejected: () => {},
    onConnectError: () => {},
  });
  stale.connect();
  const staleRow = async () => (await health()).fleet.machines.find((m) => m.nodeId === 'stale');
  // The refusal is the broker's only chance to learn the build; wait until it has recorded it.
  expect(await until(async () => ((await staleRow())?.release.current ?? null) !== null)).toBe(true);
  const row = await staleRow();
  stale.disconnect();

  // The one moment anyone in the fleet learns this build exists is the instant before it is refused.
  // Without keeping it, the row below is indistinguishable from a machine whose network died.
  expect(row?.release.current).toBe('0.9.0');
  expect(row?.release.ok).toBe(false);
  expect(row?.release.latest).toBeNull();
  expect(row?.behind).toBe('major');
});

test('three states are distinct in one answer', async () => {
  const fleet = (await health()).fleet;
  expect(fleet.latest).toBe(RELEASE_VERSION);

  const current = fleet.machines.find((m) => m.nodeId === 'worker');
  const stale = fleet.machines.find((m) => m.nodeId === 'stale');
  const unseen = fleet.machines.find((m) => m.nodeId === 'never-seen');

  // Level with the fleet, and confirmed so.
  expect(current?.online).toBe(true);
  expect(current?.behind).toBeNull();
  expect(current?.release.latest).toBe(RELEASE_VERSION);

  // Behind, and by how much — the fact that used to die in the journal.
  expect(stale?.behind).toBe('major');
  expect(stale?.release.current).toBe('0.9.0');

  // Never introduced itself: no build to name, and emphatically not "fine".
  expect(unseen?.online).toBe(false);
  expect(unseen?.release.current).toBeNull();
  expect(unseen?.behind).toBeNull();
  expect(unseen?.release.latest).toBeNull();
});

test('a build this scheme cannot rank is not reported as level with the fleet', () => {
  // Parsed loosely, `0.17.0-rc1` compared EQUAL to `0.17.0` — so a node the broker had just refused
  // over its version would have been classified "not behind". Unrankable means unranked.
  expect(behindBy('0.17.0-rc1', '0.17.0')).toBeNull();
  expect(comparableVersions('0.17.0-rc1', '0.17.0')).toBe(false);
  expect(comparableVersions('0.17.0', '0.17.0')).toBe(true);
  expect(comparableVersions(null, '0.17.0')).toBe(false);
  // And the caller can tell the two apart, which is the whole point of the second function.
  expect(behindBy('0.17.0', '0.17.0')).toBeNull();
  expect(comparableVersions('0.17.0', '0.17.0')).toBe(true);
});

test('the worse classification wins, whatever order the lanes are in', () => {
  // `??` picked the first non-null, so a node seen as `patch` behind by the lane listed first beat
  // the same node seen as `major` behind by the other. That understates, and understating is what
  // an operator acts on.
  expect(worseBehind('patch', 'major')).toBe('major');
  expect(worseBehind('major', 'patch')).toBe('major');
  expect(worseBehind(null, 'minor')).toBe('minor');
  expect(worseBehind('minor', null)).toBe('minor');
  expect(worseBehind(null, null)).toBeNull();
  expect(worseBehind('minor', 'major')).toBe('major');
});

test("a multi-homed node never reports one lane's build beside another lane's verdict", async () => {
  // The row that motivated this: broker A holds a stranded 0.16.0 for a node that has since been
  // upgraded and repointed at broker B. Merging the fields independently produced
  // "serving v0.17.0 MAJOR BEHIND the fleet" — a version equal to the fleet's, next to a verdict
  // saying it is not. Whatever the merge chooses, the pair must come from one observation.
  const lanes = [
    {
      nodeId: 'z',
      online: false,
      serves: false,
      connections: 0,
      since: null,
      version: '0.16.0',
      behind: 'major' as const,
      versionSeenAt: '2026-08-25T10:00:00.000Z',
      departure: null,
      observingSince: '2026-08-25T09:00:00.000Z',
    },
    {
      nodeId: 'z',
      online: true,
      serves: true,
      connections: 1,
      since: '2026-08-25T12:00:00.000Z',
      version: RELEASE_VERSION,
      behind: null,
      versionSeenAt: '2026-08-25T12:00:00.000Z',
      departure: null,
      observingSince: '2026-08-25T11:00:00.000Z',
    },
  ] satisfies Presence[];
  for (const order of [lanes, [...lanes].reverse()]) {
    // Not `as never`: these casts are what let a required new field reach production unnoticed
    // once already — the fixture typechecked by refusing to be checked at all.
    const [first, second] = order as [Presence, Presence];
    const merged = mergePresence(first, second);
    // The pair is coherent: the named build is the one the verdict was computed from.
    const recomputed = behindBy(merged.version ?? '', RELEASE_VERSION);
    expect(merged.behind).toBe(recomputed);
    expect(merged.versionSeenAt).toBe(
      order.find((lane) => lane.version === merged.version)?.versionSeenAt ?? null,
    );
  }
});

test('an unsettled node says nothing has confirmed it — never that a check succeeded', async () => {
  // `ok` used to default to true before any dial settled, so a node could report a failed attempt's
  // timestamp stamped `ok: true`, and the door disagreed with the broker's aggregate about the same
  // machine. `checkedAt: null` is what separates "not asked yet" from "asked and failed".
  const response = await fetch('http://localhost/wire/status', { unix: join(root, 'orphan.sock') });
  const status = LocalStatusSchema.parse(await response.json());
  const release = status.release;
  if (release === undefined) throw new Error('the door published no release standing');
  expect(release.ok).toBe(false);
  // Whatever the pair is, it is never "a check succeeded" without a check.
  expect(release.ok && release.checkedAt === null).toBe(false);
});

test('an admitted machine carries the moment it was admitted, not an empty timestamp', async () => {
  const row = (await health()).fleet.machines.find((m) => m.nodeId === 'worker');
  expect(row?.online).toBe(true);
  expect(row?.release.ok).toBe(true);
  // Every verified machine used to be the one with no timestamp — the opposite of useful for a
  // reader asking how stale the answer is. The broker had the fact on the same row all along.
  expect(row?.release.checkedAt).not.toBeNull();
});
