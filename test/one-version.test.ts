/**
 * One fleet, one version.
 *
 * The handshake is the only place a version is checked in this project, so this is the only place
 * that can prove a half-finished rollout presents itself instead of producing a fleet that looks
 * healthy and behaves oddly.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRealtimeClient } from 'stitchkit';
import { loadLanePeer } from '../packages/runtime/src/transport/lane-peer.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';
import { wireContract } from '../packages/contracts/src/realtime-contract.ts';
import { brokerConfig, freePort, until } from './support.ts';

const PORT = freePort();
const TOKEN = 'q'.repeat(40);
let broker: Awaited<ReturnType<typeof startBroker>>;
let auditPath: string;

beforeAll(async () => {
  auditPath = join(mkdtempSync(join(tmpdir(), 'stitchwire-one-version-')), 'audit.jsonl');
  broker = await startBroker(brokerConfig({ worker: TOKEN }, { port: PORT, auditPath }));
});

afterAll(async () => {
  await broker?.stop();
});

function dial(version: string, transports: Array<'websocket' | 'polling'> = ['websocket']) {
  const client = createRealtimeClient(wireContract, {
    peers: { client: loadLanePeer },
    url: `http://127.0.0.1:${PORT}`,
    auth: () => ({ nodeId: 'worker', token: TOKEN, serves: true, version }),
    withCredentials: false,
    transports,
    reconnectionDelay: 50,
    reconnectionDelayMax: 50,
    onRejected: () => {},
    onConnectError: () => {},
  });
  client.connect();
  return client;
}

test('a node on this exact release is admitted', async () => {
  const client = dial(RELEASE_VERSION);
  try {
    expect(await until(() => client.connected, 4_000)).toBe(true);
  } finally {
    client.disconnect();
  }
});

test('polling carries the same binary codec and acknowledgements', async () => {
  const client = dial(RELEASE_VERSION, ['polling']);
  try {
    expect(await until(() => client.connected, 4000)).toBe(true);
    const nodes = await client.request('nodes:list', { timeoutMs: 2000 });
    expect(nodes.some((node) => node.nodeId === 'worker')).toBe(true);
  } finally {
    client.disconnect();
  }
});

test('the broker registry has one credential shape', () => {
  expect(
    BrokerConfigSchema.safeParse({
      nodes: [{ id: 'worker', tokenSha256: sha256(TOKEN) }],
    }).success,
  ).toBe(false);
  expect(
    BrokerConfigSchema.safeParse({
      nodes: [{ id: 'worker', tokenSha256s: [sha256(TOKEN)] }],
    }).success,
  ).toBe(true);
});

test('a node on another release is refused, with a token that is perfectly good', async () => {
  const client = dial('0.0.1');
  try {
    // The token authenticates; only the version does not. Admitting it would give a fleet that
    // looks healthy and answers unpredictably, which is the failure this replaces.
    // Absence: a refused build never connects, so the whole budget is spent and the answer is no.
    expect(await until(() => client.connected, 2_000)).toBe(false);
  } finally {
    client.disconnect();
  }

  const lines = readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).event as { kind: string; detail?: string });
  const refusals = lines.filter((line) => line.kind === 'connect-refused');
  const refusal = refusals[refusals.length - 1];
  // The detail must name both versions: a rollout that stopped halfway has to read as a rollout
  // that stopped halfway, not as an authentication problem on a machine whose token is fine.
  expect(refusal?.detail).toContain('0.0.1');
  expect(refusal?.detail).toContain(RELEASE_VERSION);
});
