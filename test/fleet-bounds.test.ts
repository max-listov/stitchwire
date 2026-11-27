import { describe, expect, test } from 'bun:test';
import { FLEET_BUNDLE_FORMAT, FleetBundleSchema } from '../packages/contracts/src/fleet/bundle.ts';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { MAX_NODES, MAX_TOPIC_RETAINED_BYTES } from '../packages/contracts/src/protocol/bounds.ts';
import { DepartureSchema, PresenceSchema } from '../packages/contracts/src/protocol/presence.ts';
import { MAX_DECLARED_TOPICS } from '../packages/contracts/src/protocol/topic.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';

/**
 * The bounds Wire's own readers put on what they accept. Each one is held at its edge: the largest
 * value passes and the next is refused with the bound named, so a limit moved or dropped fails here.
 */

const nodeName = (index: number): string => `n${index}`;
const members = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [nodeName(index), { copy: 'own' }]));
const refusal = (
  schema: { safeParse(value: unknown): { success: boolean; error?: unknown } },
  value: unknown,
) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? '' : JSON.stringify(parsed.error);
};

describe('a fleet names at most MAX_NODES nodes', () => {
  const manifest = (count: number) => ({ version: 1, members: members(count), access: [] });

  test('a manifest of exactly the limit parses and one more member is refused', () => {
    expect(MAX_NODES).toBe(1024);
    expect(FleetManifestSchema.safeParse(manifest(MAX_NODES)).success).toBe(true);
    expect(refusal(FleetManifestSchema, manifest(MAX_NODES + 1))).toContain('at most 1024 nodes');
  });

  test('a bundle carries at most MAX_NODES slices', () => {
    const signed = { keyId: 'signer', payload: '{}', signature: 'A'.repeat(86) };
    const bundle = (count: number) => ({
      format: FLEET_BUNDLE_FORMAT,
      serial: 1,
      full: null,
      slices: Object.fromEntries(Array.from({ length: count }, (_, index) => [nodeName(index), signed])),
    });
    expect(FleetBundleSchema.safeParse(bundle(MAX_NODES)).success).toBe(true);
    expect(refusal(FleetBundleSchema, bundle(MAX_NODES + 1))).toContain('at most 1024 slices');
  });
});

describe('a presence row bounds the strings a broker reports', () => {
  const departure = (at: string) => ({ at, reason: 'transport close', kind: 'lost' });
  const presence = (patch: Record<string, unknown>) => ({
    nodeId: 'alpha',
    online: true,
    serves: true,
    connections: 1,
    since: null,
    version: null,
    behind: null,
    versionSeenAt: null,
    departure: null,
    observingSince: '2026-10-20T00:00:00.000Z',
    ...patch,
  });

  test('`at` and `since` are accepted at 64 characters and refused at 65', () => {
    expect(DepartureSchema.safeParse(departure('x'.repeat(64))).success).toBe(true);
    expect(DepartureSchema.safeParse(departure('x'.repeat(65))).success).toBe(false);
    expect(PresenceSchema.safeParse(presence({ since: 'x'.repeat(64) })).success).toBe(true);
    expect(PresenceSchema.safeParse(presence({ since: 'x'.repeat(65) })).success).toBe(false);
    expect(PresenceSchema.safeParse(presence({ departure: departure('x'.repeat(65)) })).success).toBe(false);
  });
});

describe('a fleet topic namespace carries the limits a broker configuration enforces', () => {
  const grant = (patch: Record<string, unknown>) => ({
    producer: 'alpha',
    subscribers: ['beta'],
    maxTopics: 1,
    ...patch,
  });
  const inFleet = (namespace: Record<string, unknown>) =>
    FleetManifestSchema.safeParse({
      version: 1,
      members: { alpha: { copy: 'full' }, beta: { copy: 'own' } },
      access: [],
      topicNamespaces: { 'owner.': namespace },
    }).success;
  const inBroker = (namespace: Record<string, unknown>) => {
    const named = [
      String(namespace.producer),
      ...(Array.isArray(namespace.subscribers) ? namespace.subscribers : []),
    ];
    return BrokerConfigSchema.safeParse({
      port: 8790,
      nodes: [...new Set(named)].map((id) => ({ id, tokenSha256s: ['a'.repeat(64)] })),
      topicNamespaces: { 'owner.': namespace },
    }).success;
  };

  const subscribers = (count: number) => Array.from({ length: count }, (_, index) => `s${index}`);
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ['maxTopics at the limit', grant({ maxTopics: MAX_DECLARED_TOPICS }), true],
    ['maxTopics above the limit', grant({ maxTopics: MAX_DECLARED_TOPICS + 1 }), false],
    ['maxTopics zero', grant({ maxTopics: 0 }), false],
    ['retained bytes at the limit', grant({ maxRetainedBytes: MAX_TOPIC_RETAINED_BYTES }), true],
    ['retained bytes above the limit', grant({ maxRetainedBytes: MAX_TOPIC_RETAINED_BYTES + 1 }), false],
    ['no subscriber', grant({ subscribers: [] }), false],
    ['an unknown field', grant({ extra: true }), false],
  ];

  test.each(cases)('%s: the fleet and the broker agree', (_name, namespace, accepted) => {
    expect(inFleet(namespace)).toBe(accepted);
    expect(inBroker(namespace)).toBe(accepted);
  });

  test('256 subscribers are the most a grant names', () => {
    const fleet = (count: number) =>
      FleetManifestSchema.safeParse({
        version: 1,
        members: {
          alpha: { copy: 'full' },
          ...Object.fromEntries(subscribers(count).map((id) => [id, { copy: 'own' }])),
        },
        access: [],
        topicNamespaces: { 'owner.': grant({ subscribers: subscribers(count) }) },
      }).success;
    expect(fleet(256)).toBe(true);
    expect(fleet(257)).toBe(false);
    expect(inBroker(grant({ subscribers: subscribers(256) }))).toBe(true);
    expect(inBroker(grant({ subscribers: subscribers(257) }))).toBe(false);
  });
});
