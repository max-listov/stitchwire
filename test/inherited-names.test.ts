import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ownEntry } from '../packages/runtime/src/json.ts';
import { Registry } from '../packages/runtime/src/broker/registry.ts';
import { ServiceGrantRegistry } from '../packages/runtime/src/service/grant-registry.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { EnrollmentAdmissionRequestSchema } from '../packages/contracts/src/enrollment/request.ts';
import { OwnersLedger } from '../packages/runtime/src/enrollment/owners.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';
import { capabilitiesFor, nodeTables } from '../packages/runtime/src/fleet/projection.ts';

test('constructor is an ordinary node and owner name, never an inherited grant or namespace', () => {
  const manifest = FleetManifestSchema.parse({
    version: 1,
    members: { constructor: { copy: 'own' } },
    access: [{ from: 'constructor', to: '*', peer: true }],
  });
  expect(nodeTables(manifest, 'constructor').services.namespaces).toEqual([]);
  expect(ownEntry(capabilitiesFor(manifest, new Set(['constructor'])), 'constructor')).toEqual([
    { operation: 'peer', targets: ['*'] },
  ]);
  const config = BrokerConfigSchema.parse({ nodes: [{ id: 'constructor', tokenSha256s: ['a'.repeat(64)] }] });
  expect(new Registry(config).mayPerform('peer', 'constructor', 'worker')).toBe(false);
  const grant = {
    caller: 'reader',
    target: 'constructor',
    service: 'owner.read',
    scope: { kind: 'service-read' as const },
  };
  expect(
    new ServiceGrantRegistry(config).declare('constructor', { target: 'constructor', grants: [grant] })
      .accepted,
  ).toBe(0);
  const explicit = BrokerConfigSchema.parse({
    ...config,
    capabilities: { constructor: [{ operation: 'peer', targets: ['*'] }] },
    serviceNamespaces: { constructor: ['owner.'] },
  });
  expect(new Registry(explicit).mayPerform('peer', 'constructor', 'worker')).toBe(true);
  expect(
    new ServiceGrantRegistry(explicit).declare('constructor', { target: 'constructor', grants: [grant] })
      .accepted,
  ).toBe(1);
  const root = mkdtempSync('/tmp/wire-owner-name-');
  try {
    const request = EnrollmentAdmissionRequestSchema.parse({
      v: 1,
      kind: 'admission',
      requestId: crypto.randomUUID(),
      expectedVersion: RELEASE_VERSION,
      nodeId: 'worker',
      config: join(root, 'broker.json'),
      tokenSha256: 'a'.repeat(64),
    });
    const ledger = OwnersLedger.read(request.config);
    expect(ledger.bindings('constructor')).toEqual([]);
    ledger.set('constructor', [], true);
    ledger.confirm('constructor');
    expect(OwnersLedger.read(request.config).bindings('constructor')).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
