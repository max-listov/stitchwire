import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EnrollmentNodeRequestSchema } from '../packages/contracts/src/enrollment/request.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import {
  installationReserved,
  requestedInstallation,
  reserveInstallation,
} from '../packages/runtime/src/enrollment/installation.ts';
import { enrollmentRoot } from '../packages/runtime/src/enrollment/journal.ts';
import { renderUnit } from '../packages/runtime/src/enrollment/unit.ts';

/**
 * The bytes of an installed unit are part of every installation already made. Its reservation
 * records their SHA-256, and a repeated enrollment of the same request compares the unit it would
 * render now with that record: a renderer that writes other bytes for the same layout turns every
 * installed node's repeated enrollment into `runtime-conflict`. So the bytes are pinned here, and
 * changing them is a decision taken together with what installed nodes need, never a side effect.
 */

const layout = {
  role: 'agent',
  bun: '/opt/bun/bin/bun',
  runtime: '/srv/stitchwire/bin/stitchwire',
  config: '/srv/stitchwire/config/node.json',
  configDir: '/srv/stitchwire/config',
  stateDir: '/srv/stitchwire/state',
} as const;

const service = (wantedBy: string) =>
  [
    '[Unit]',
    'Description=Stitchwire agent',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=exec',
    'ExecStart="/opt/bun/bin/bun" "/srv/stitchwire/bin/stitchwire" "agent" "--config" "/srv/stitchwire/config/node.json"',
    'Environment="STITCHWIRE_CONFIG_DIR=/srv/stitchwire/config" "STITCHWIRE_STATE_DIR=/srv/stitchwire/state"',
    'Restart=always',
    'RestartSec=2',
    'UMask=0077',
    'NoNewPrivileges=true',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    `WantedBy=${wantedBy}`,
    '',
  ].join('\n');

test('an installation unit renders exactly these bytes, whose digest installed nodes recorded', () => {
  const system = renderUnit({ ...layout, scope: 'system' });
  const user = renderUnit({ ...layout, scope: 'user' });
  expect(system).toBe(service('multi-user.target'));
  expect(user).toBe(service('default.target'));
  expect([sha256(system), sha256(user)]).toEqual([
    'ad0dfdf21c186de510bf438efed76d82b8c0931ea2ad3e7ff751079d0a1a09f1',
    'a2e54d3c0fb5eaf7e6b18ec068f843acec54c2bd1d4dfdc4298dd77b055e3e9a',
  ]);
});

const root = realpathSync(mkdtempSync('/tmp/wire-unit-bytes-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('a repeated request is reserved by the record of its render, and another render is a conflict', () => {
  const config = join(root, 'config/node.json');
  mkdirSync(enrollmentRoot(config), { recursive: true, mode: 0o700 });
  const request = EnrollmentNodeRequestSchema.parse({
    v: 1,
    kind: 'node',
    requestId: crypto.randomUUID(),
    nodeId: 'worker',
    expectedVersion: '1.2.3',
    config,
    brokers: [{ id: 'primary', url: 'https://broker.example' }],
    agentSocket: join(root, 'state/agent.sock'),
    supervisor: {
      kind: 'systemd',
      scope: 'system',
      bun: process.execPath,
      artifact: {
        source: '/tmp/stitchwire',
        destination: join(root, 'bin/stitchwire'),
        sha256: '0'.repeat(64),
      },
    },
    owner: { id: 'example', descriptors: [] },
  });
  const installation = requestedInstallation(request);
  if (installation === null) throw new Error('a systemd request has an installation');
  expect(installationReserved(config, installation)).toBe(false);
  reserveInstallation(config, installation);
  expect(installationReserved(config, installation)).toBe(true);
  // The same request rendered by a renderer that writes one more byte: what installed nodes would meet.
  const rerendered = `${installation.unitText}\n`;
  const later = {
    ...installation,
    unitText: rerendered,
    supervision: { ...installation.supervision, unitSha256: sha256(rerendered) },
  };
  expect(() => installationReserved(config, later)).toThrow('runtime-conflict');
});
