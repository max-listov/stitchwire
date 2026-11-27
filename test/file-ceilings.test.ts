import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EnrollmentNodeRequest } from '../packages/contracts/src/enrollment/request.ts';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { ServiceDescriptorSchema } from '../packages/contracts/src/service/policy-schema.ts';
import { loadNodeConfig } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { EnrollmentError } from '../packages/runtime/src/enrollment/failure.ts';
import { verifiedCopy } from '../packages/runtime/src/enrollment/material.ts';
import { checkProofDescriptor } from '../packages/runtime/src/enrollment/observe.ts';
import { FleetFollower } from '../packages/runtime/src/node/fleet-follower.ts';
import { fleetSigner } from './signed-fleet.ts';

/**
 * A configuration or a kept fleet copy is read whole up to 16 MiB, and a service descriptor up to
 * 256 KiB, by the agent and by enrollment alike. The sizes are written out here rather than taken from the constant, so a reader that brings
 * its own smaller default (1 MiB is common) turns this red instead of moving the test along with it.
 */
const MiB = 1024 * 1024;
const WITHIN = 2 * MiB;
const ABOVE = 16 * MiB + 1;

const root = mkdtempSync(join(tmpdir(), 'wire-config-ceiling-'));
const key = fleetSigner('signer');
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The same JSON value, padded with insignificant whitespace to exactly `bytes`. */
function padded(value: unknown, bytes: number): string {
  const text = JSON.stringify(value);
  if (text.length + 1 > bytes) throw new Error('the value is larger than the padding target');
  return `${text}${' '.repeat(bytes - text.length - 1)}\n`;
}

function nodeConfig(copy: string) {
  return {
    nodeId: 'reader',
    brokers: [{ id: 'primary', url: 'http://127.0.0.1:1', token: 't'.repeat(40) }],
    fleet: { trust: key.trust, copy, pollMs: 60_000 },
  };
}

test('a node.json between 1 and 16 MiB loads, and one above 16 MiB is refused', () => {
  const path = join(root, 'node.json');
  const config = nodeConfig(join(root, 'unused-copy.json'));
  writeFileSync(path, padded(config, WITHIN), { mode: 0o600 });
  expect(loadNodeConfig(path).nodeId).toBe('reader');
  writeFileSync(path, padded(config, ABOVE), { mode: 0o600 });
  expect(() => loadNodeConfig(path)).toThrow(`File exceeds ${16 * MiB}-byte limit`);
});

test('a kept copy between 1 and 16 MiB is the edition for the agent and for enrollment', () => {
  const copy = join(root, 'within-fleet.json');
  const manifest = FleetManifestSchema.parse({
    version: 1,
    members: { reader: { copy: 'own' } },
    access: [],
  });
  writeFileSync(copy, padded(key.edition(manifest, 7), WITHIN), { mode: 0o600 });
  // Enrollment reads first: an agent that adopts the copy writes it back compactly.
  expect(statSync(copy).size).toBe(WITHIN);
  expect(verifiedCopy(copy, key.trust, false).serial).toBe(7);
  const config = NodeConfigSchema.parse(nodeConfig(copy));
  const follower = new FleetFollower('reader', config.fleet, config, undefined, undefined);
  try {
    follower.start();
    // The first poll reads the kept copy synchronously inside `start`.
    expect(follower.snapshot().serial).toBe(7);
  } finally {
    follower.stop();
  }
});

test('a kept copy above 16 MiB is refused by the agent and by enrollment', () => {
  const copy = join(root, 'above-fleet.json');
  const manifest = FleetManifestSchema.parse({
    version: 1,
    members: { reader: { copy: 'own' } },
    access: [],
  });
  writeFileSync(copy, padded(key.edition(manifest, 7), ABOVE), { mode: 0o600 });
  const config = NodeConfigSchema.parse(nodeConfig(copy));
  const follower = new FleetFollower('reader', config.fleet, config, undefined, undefined);
  try {
    follower.start();
    const status = follower.snapshot();
    expect(status.serial).toBeNull();
    expect(status.detail).toContain(`is unreadable: File exceeds ${16 * MiB}-byte limit`);
  } finally {
    follower.stop();
  }
  let refusal: unknown;
  try {
    verifiedCopy(copy, key.trust, false);
  } catch (error) {
    refusal = error;
  }
  expect(refusal).toBeInstanceOf(EnrollmentError);
  expect((refusal as EnrollmentError).code).toBe('state-invalid');
  expect(((refusal as EnrollmentError).cause as Error).message).toContain(`exceeds ${16 * MiB}-byte limit`);
});

test('a proof descriptor is read with the descriptor ceiling the agent applies, 256 KiB', () => {
  const descriptor = join(root, 'proof-descriptor.json');
  const value = ServiceDescriptorSchema.parse({
    service: 'example.probe',
    revision: '1',
    maxInflight: 1,
    operations: [
      {
        id: 'read',
        path: '/read',
        effect: 'read',
        limits: { requestBytes: 1024, responseBytes: 1024, timeoutMs: 1000 },
        response: { kind: 'unary' },
      },
    ],
  });
  const call = { to: 'observer', service: 'example.probe', revision: '1', operation: 'read' };
  // Only the fields the check reads; the request schema is held by its own tests.
  const request = { nodeId: 'reader', proof: { descriptor, call } } as unknown as EnrollmentNodeRequest;
  writeFileSync(descriptor, padded(value, 256 * 1024), { mode: 0o600 });
  expect(() => checkProofDescriptor(request)).not.toThrow();
  writeFileSync(descriptor, padded(value, 256 * 1024 + 1), { mode: 0o600 });
  let refusal: unknown;
  try {
    checkProofDescriptor(request);
  } catch (error) {
    refusal = error;
  }
  expect((refusal as EnrollmentError).code).toBe('state-invalid');
  expect(((refusal as EnrollmentError).cause as Error).message).toContain(`exceeds ${256 * 1024}-byte limit`);
});
