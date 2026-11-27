import { expect, test } from 'bun:test';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { brokerTables, nodeTables } from '../packages/runtime/src/fleet/projection.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';

test('wildcard service rules refuse at manifest ingress; concrete services and partial-roster peers/topics project', () => {
  const members = { alpha: { copy: 'own' }, beta: { copy: 'own' }, gamma: { copy: 'own' } };
  expect(
    FleetManifestSchema.safeParse({
      version: 1,
      members,
      access: [{ from: 'alpha', to: '*', services: { 'owner.catalog': ['service-read'] } }],
    }).success,
  ).toBe(false);
  const manifest = FleetManifestSchema.parse({
    version: 1,
    members,
    access: [
      { from: 'alpha', to: '*', peer: true },
      { from: 'alpha', to: 'gamma', peer: true },
      { from: 'alpha', to: 'beta', services: { 'owner.catalog': ['service-read'] } },
    ],
    topics: {
      'owner.local': { producer: 'alpha', subscribers: ['beta', 'gamma'], delivery: 'ordered' },
      'owner.foreign': { producer: 'alpha', subscribers: ['gamma'], delivery: 'ordered' },
    },
  });
  const nodes = ['alpha', 'beta'].map((id) => ({ id, tokenSha256s: ['a'.repeat(64)] }));
  const tables = brokerTables(manifest, new Set(nodes.map((node) => node.id)));
  const projected = BrokerConfigSchema.parse({ nodes, ...tables });
  expect(projected.topics['owner.local']?.subscribers).toEqual(['beta']);
  expect(projected.topics['owner.foreign']).toBeUndefined();
  expect(projected.capabilities.alpha).toContainEqual({ operation: 'peer', targets: ['*'] });
  expect(projected.capabilities.alpha?.some((entry) => entry.targets.includes('gamma'))).toBe(false);
  expect(projected.serviceGrants).toHaveLength(1);
  expect(nodeTables(manifest, 'beta').services.grants).toHaveLength(1);
  expect(nodeTables(manifest, 'gamma').events.subscribe).toContain('owner.local');
});
