import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as surface from '../packages/client/src/enrollment.ts';
import { EnrollmentNodeRequestSchema, EnrollmentResultSchema } from '../packages/client/src/enrollment.ts';
import { MINIMUM_BUN_VERSION, supportsBun } from '../packages/contracts/src/enrollment/request.ts';

test('the enrollment entry of the SDK exports exactly its documented names', () => {
  // A name added here becomes a promise to every orchestrator: it is added on purpose, never by `export *`.
  expect(Object.keys(surface).sort()).toEqual([
    'ENROLLMENT_OPERATIONS',
    'EnrollmentAdmissionRequestSchema',
    'EnrollmentCodeSchema',
    'EnrollmentCredentialSchema',
    'EnrollmentFailureSchema',
    'EnrollmentMaterialSchema',
    'EnrollmentNodeRequestSchema',
    'EnrollmentOperationSchema',
    'EnrollmentPhaseSchema',
    'EnrollmentRequestSchema',
    'EnrollmentResultSchema',
    'FleetAdmissionCodeSchema',
    'FleetAdmissionNodeRequestSchema',
    'FleetAdmissionOperationSchema',
    'FleetAdmissionPhaseSchema',
    'FleetAdmissionRequestSchema',
    'FleetAdmissionResultSchema',
    'FleetAdmissionStatusSchema',
    'MINIMUM_BUN_VERSION',
    'supportsBun',
  ]);
});

test('the minimum Bun is one fact: the contract, its predicate and the SDK engines agree', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../packages/client/package.json'), 'utf8'),
  );
  expect(manifest.engines.bun).toBe(`>=${MINIMUM_BUN_VERSION}`);
  const [major = 0, minor = 0, patch = 0] = MINIMUM_BUN_VERSION.split('.').map(Number);
  expect(supportsBun(MINIMUM_BUN_VERSION)).toBe(true);
  expect(supportsBun(`${major}.${minor}.${patch + 1}`)).toBe(true);
  expect(supportsBun(`${major}.${minor + 1}.0`)).toBe(true);
  expect(supportsBun(`${major + 1}.0.0`)).toBe(true);
  // Negative controls: one step below in each position, and an answer that is not a version.
  if (patch > 0) expect(supportsBun(`${major}.${minor}.${patch - 1}`)).toBe(false);
  if (minor > 0) expect(supportsBun(`${major}.${minor - 1}.99`)).toBe(false);
  expect(supportsBun(`${major - 1}.99.99`)).toBe(false);
  expect(supportsBun('bun: command not found')).toBe(false);
});

const request = {
  v: 1,
  kind: 'node',
  requestId: '6f3c1d5e-0f8b-4c56-9d2a-2b1f5e7c9a10',
  nodeId: 'worker',
  expectedVersion: '1.2.3',
  config: '/srv/node/node.json',
  brokers: [{ id: 'primary', url: 'https://broker.example' }],
  agentSocket: '/srv/node/agent.sock',
  owner: { id: 'example', descriptors: [] },
};
const artifact = {
  source: '/tmp/stitchwire',
  destination: '/srv/node/bin/stitchwire',
  sha256: '0'.repeat(64),
};
const systemd = { kind: 'systemd', scope: 'system', bun: '/usr/bin/bun' };

test('a request names a runtime exactly when it asks for a new installation', () => {
  const parses = (supervisor: unknown, extra: object = {}) =>
    EnrollmentNodeRequestSchema.safeParse({ ...request, supervisor, ...extra }).success;
  expect(parses({ kind: 'existing' })).toBe(true);
  expect(parses({ ...systemd, artifact })).toBe(true);
  // What could only be ignored or refused later is refused by the schema.
  expect(parses(systemd)).toBe(false);
  expect(parses({ kind: 'existing', artifact })).toBe(false);
  expect(parses({ kind: 'existing' }, { artifact })).toBe(false);
});

test('a result carries the fields of its own status and no others', () => {
  const shell = {
    v: 1,
    requestId: request.requestId,
    nodeId: 'worker',
    operation: 'status',
    observedAt: '2026-01-01T00:00:00.000Z',
    completed: [],
    firstFailure: null,
  };
  const runtime = { version: '1.2.3', installation: null };
  const ready = { ...shell, kind: 'node', status: 'ready', credentials: [], runtime, proof: null };
  const parsed = EnrollmentResultSchema.parse(ready);
  // The type follows the status: no null check stands between `ready` and its runtime.
  if (parsed.status !== 'ready') throw new Error('a ready result parses as ready');
  expect(parsed.runtime.version).toBe('1.2.3');
  const failure = { code: 'busy', phase: 'configuration', at: shell.observedAt, systemCode: 'LOCK_TIMEOUT' };
  const refused = EnrollmentResultSchema.parse({ ...shell, status: 'failed', failure });
  if (refused.status !== 'failed') throw new Error('a refusal parses as failed');
  expect(refused.failure.code).toBe('busy');
  for (const invalid of [
    { ...ready, runtime: undefined },
    { ...ready, failure },
    { ...shell, kind: 'node', status: 'planned', credentials: [], runtime },
    { ...shell, status: 'failed' },
    { ...shell, kind: 'admission', status: 'admitted', admitted: [] },
  ])
    expect(EnrollmentResultSchema.safeParse(invalid).success).toBe(false);
});
