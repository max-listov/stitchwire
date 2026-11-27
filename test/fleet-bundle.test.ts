import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FleetBundle, FleetSlicePayloadSchema } from '../packages/contracts/src/fleet/bundle.ts';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import {
  buildBundle,
  nextSerial,
  openBundle,
  reduceBundle,
  tablesFor,
} from '../packages/runtime/src/fleet/bundle.ts';
import {
  applyBrokerTables,
  applyNodeTables,
  brokerTables,
  brokerTablesOf,
  capabilitiesFor,
  commandGrantsFor,
  namespacesFor,
  nodeTables,
  roster,
  sameTables,
  servedBy,
  serviceGrantsFor,
} from '../packages/runtime/src/fleet/projection.ts';
import { reconcile } from '../packages/runtime/src/fleet/reconcile.ts';
import { generateSigningKey, openDocument, signDocument } from '../packages/runtime/src/fleet/signature.ts';
import { bundleChecks } from '../packages/runtime/src/cli/bundle-checks.ts';
import { status } from './doctor-fixture.ts';

/**
 * The fleet bundle: one manifest, signed, from which every machine projects its own tables.
 *
 * These tests hold the four properties the design stands on. A node accepts only what a trusted key
 * signed, byte for byte. A member that keeps only its own part learns nothing else about the fleet.
 * Every projection says what the manifest says and nothing it does not. And rewriting a
 * configuration never turns into a restart loop.
 */

const signer = generateSigningKey();
const trust = [{ id: 'signer', publicKey: signer.publicKey }];
const everyNode = new Set(['alpha', 'beta', 'gamma', 'edge']);

const manifest = FleetManifestSchema.parse({
  version: 1,
  members: { alpha: { copy: 'full' }, beta: { copy: 'full' }, gamma: { copy: 'own' }, edge: { copy: 'own' } },
  access: [
    { from: 'alpha', to: '*', peer: true },
    { from: 'alpha', to: 'beta', commands: ['probe', 'inventory'], stream: true },
    { from: 'alpha', to: 'gamma', commands: ['probe'] },
    { from: 'edge', to: 'alpha', services: { 'owner.relay': ['service-read', 'alert.deliver'] } },
    { from: 'beta', to: 'gamma', services: { 'owner.window': ['service-read'] } },
  ],
  topics: {
    'release.gamma.lifecycle': { producer: 'gamma', subscribers: ['alpha'], delivery: 'ordered' },
  },
  topicNamespaces: {
    'owner.beta.': { producer: 'beta', subscribers: ['alpha', 'edge'], maxTopics: 8 },
  },
  serviceNamespaces: { gamma: ['owner.'], beta: ['owner.'] },
});

const bundle = (serial = 7, body = manifest): FleetBundle =>
  buildBundle({
    manifest: body,
    serial,
    issuedAt: '2026-09-15T01:00:00.000Z',
    keyId: 'signer',
    privateKeyPem: signer.privateKeyPem,
  });

describe('the manifest names every node it grants anything to', () => {
  const base = { version: 1, members: { alpha: { copy: 'full' }, beta: { copy: 'own' } }, access: [] };
  const refusal = (value: unknown): string => {
    const parsed = FleetManifestSchema.safeParse(value);
    return parsed.success ? '' : parsed.error.issues.map((issue) => issue.message).join('\n');
  };

  test('a grant to a node that is not a member is refused where it is written', () => {
    expect(refusal({ ...base, access: [{ from: 'alpha', to: 'ghost', peer: true }] })).toContain(
      "'ghost' is not a member",
    );
    expect(refusal({ ...base, serviceNamespaces: { ghost: ['owner.'] } })).toContain('not a member');
  });

  test('a pair that grants nothing, a pair stated twice and overlapping namespaces are refused', () => {
    expect(refusal({ ...base, access: [{ from: 'alpha', to: 'beta' }] })).toContain('grants nothing');
    expect(
      refusal({
        ...base,
        access: [
          { from: 'alpha', to: 'beta', peer: true },
          { from: 'alpha', to: 'beta', commands: ['probe'] },
        ],
      }),
    ).toContain('duplicate access pair');
    const grant = (producer: string) => ({ producer, subscribers: ['alpha'], maxTopics: 1 });
    expect(
      refusal({ ...base, topicNamespaces: { 'owner.': grant('alpha'), 'owner.beta.': grant('beta') } }),
    ).toContain('overlaps');
  });

  test('a topic profile the broker would refuse is refused in the manifest', () => {
    expect(
      refusal({
        ...base,
        topics: {
          't.one': {
            producer: 'alpha',
            subscribers: ['beta'],
            delivery: 'latest-wins',
            retain: { maxAgeMs: 1000, maxBytes: 1024 },
          },
        },
      }),
    ).toContain('latest-wins topic cannot retain');
  });
});

describe('each machine projects exactly what the manifest says about it', () => {
  test('a broker carries only what its own roster can exercise', () => {
    const tables = brokerTables(manifest, new Set(['alpha', 'beta', 'gamma']));
    const rendered = JSON.stringify(tables);
    // `edge` dials another broker: nothing about it may appear here, not even as a reader.
    expect(rendered).not.toContain('edge');
    expect(JSON.stringify(namespacesFor(manifest, everyNode))).toContain('edge');
  });

  test('a command grant reaches only the pairs the manifest states', () => {
    const pairs = commandGrantsFor(manifest, everyNode).flatMap((grant) =>
      grant.targets.map((target) => `${grant.caller} → ${target}:${grant.command}`),
    );
    expect(pairs.sort()).toEqual(['alpha → beta:inventory', 'alpha → beta:probe', 'alpha → gamma:probe']);
  });

  test('publish and subscribe follow the topics and namespaces, one row per operation', () => {
    const capabilities = capabilitiesFor(manifest, everyNode);
    expect(capabilities.alpha?.find((row) => row.operation === 'subscribe')?.targets).toEqual([
      'beta',
      'gamma',
    ]);
    expect(capabilities.beta?.find((row) => row.operation === 'publish')?.targets).toEqual(['beta']);
    for (const rows of Object.values(capabilities))
      expect(new Set(rows.map((row) => row.operation)).size).toBe(rows.length);
  });

  test('a node keeps every grant aimed at it, including a caller on another broker', () => {
    const forNode = serviceGrantsFor(manifest, servedBy('alpha'));
    expect(forNode.some((grant) => grant.caller === 'edge')).toBe(true);
    expect(
      serviceGrantsFor(manifest, roster(new Set(['alpha', 'beta']))).some((grant) => grant.caller === 'edge'),
    ).toBe(false);
  });

  test('a projection replaces the fleet tables and keeps everything the machine owns', () => {
    const node = applyNodeTables(
      {
        nodeId: 'gamma',
        brokers: [{ id: 'primary', url: 'https://broker.invalid', token: 't'.repeat(40) }],
        allow: { probe: { bin: '/bin/true' } },
        events: { publish: ['invented.topic'], descriptors: ['/opt/owner/topics.json'] },
        services: {
          bindings: [],
          grants: [{ caller: 'x', target: 'gamma', service: 'invented', scope: { kind: 'service-read' } }],
          descriptors: ['/opt/owner/service.json'],
        },
      },
      nodeTables(manifest, 'gamma'),
    );
    expect(node.events).toEqual({
      publish: ['release.gamma.lifecycle'],
      subscribe: [],
      namespaces: { publish: [], subscribe: [] },
      descriptors: ['/opt/owner/topics.json'],
    });
    expect(node.services).toMatchObject({ namespaces: ['owner.'], descriptors: ['/opt/owner/service.json'] });
    expect(JSON.stringify(node.services)).not.toContain('invented');
    expect(node.allow).toEqual({ probe: { bin: '/bin/true' } });
    expect((node.brokers as Array<{ token: string }>)[0]?.token).toBe('t'.repeat(40));

    const broker = applyBrokerTables(
      {
        nodes: [
          { id: 'alpha', tokenSha256s: ['a'.repeat(64)] },
          { id: 'beta', tokenSha256s: ['b'.repeat(64)] },
        ],
        commandGrants: [{ caller: 'alpha', targets: ['alpha'], command: 'invented-command' }],
      },
      manifest,
    );
    expect(JSON.stringify(broker)).not.toContain('invented-command');
    expect(BrokerConfigSchema.safeParse(broker).success).toBe(true);
  });
});

describe('a signature holds the exact bytes a trusted key signed', () => {
  test('a document opens under its key and not after any change', () => {
    const signed = signDocument({ b: 1, a: [2, 1] }, 'signer', signer.privateKeyPem);
    expect(signed.payload).toBe('{"a":[2,1],"b":1}');
    const opened = openDocument(signed, trust);
    expect(opened).toEqual({ ok: true, document: { a: [2, 1], b: 1 }, keyId: 'signer' });
    const tampered = openDocument({ ...signed, payload: '{"a":[2,1],"b":2}' }, trust);
    expect(tampered.ok ? '' : tampered.detail).toContain('does not match');
    const stranger = generateSigningKey();
    const foreign = openDocument(signDocument({ a: 1 }, 'signer', stranger.privateKeyPem), trust);
    expect(foreign.ok ? '' : foreign.detail).toContain('does not match');
    const unknown = openDocument({ ...signed, keyId: 'other' }, trust);
    expect(unknown.ok ? '' : unknown.detail).toContain('not a trusted key');
  });
});

describe('a bundle is whole, consistent and reduced before it leaves', () => {
  test('a full bundle opens, with one signed slice per own-copy member', () => {
    const opening = openBundle(bundle(), trust, { requireFull: true });
    if (!opening.ok) throw new Error(opening.detail);
    expect(opening.opened.serial).toBe(7);
    expect(opening.opened.signer).toBe('signer');
    expect([...opening.opened.slices.keys()].sort()).toEqual(['edge', 'gamma']);
    expect(tablesFor(opening.opened, 'gamma')).toEqual(nodeTables(manifest, 'gamma'));
  });

  test('an own-copy member receives its slice and learns nothing else about the fleet', () => {
    const opening = openBundle(bundle(), trust, { requireFull: true });
    if (!opening.ok) throw new Error(opening.detail);
    const reduced = reduceBundle(opening.opened, 'gamma');
    expect(reduced?.full).toBeNull();
    expect(Object.keys(reduced?.slices ?? {})).toEqual(['gamma']);
    const payload = FleetSlicePayloadSchema.parse(JSON.parse(reduced?.slices.gamma?.payload ?? '{}'));
    const said = JSON.stringify(payload);
    // Its own readers are the only other names it may see; the rest of the fleet is absent.
    for (const other of ['alpha', 'edge', 'owner.beta.', 'probe', 'inventory'])
      expect(said).not.toContain(other);
    expect(said).toContain('beta');
    const kept = openBundle(reduced, trust, { requireFull: false });
    expect(kept.ok && tablesFor(kept.opened, 'gamma')).toEqual(nodeTables(manifest, 'gamma'));
    // A reduced copy cannot be handed to a broker as the fleet's edition.
    const asFull = openBundle(reduced, trust, { requireFull: true });
    expect(asFull.ok ? '' : asFull.detail).toContain('no full part');
    expect(reduceBundle(opening.opened, 'alpha')).toBe(opening.opened.bundle);
    expect(reduceBundle(opening.opened, 'stranger')).toBeNull();
  });

  test('a slice that differs from the manifest, a swapped slice or a stale part is refused', () => {
    const full = bundle();
    const wrong = FleetManifestSchema.parse({
      ...manifest,
      access: [
        { from: 'alpha', to: 'gamma', commands: ['probe'] },
        { from: 'beta', to: 'gamma', services: { 'owner.other': ['service-read'] } },
      ],
    });
    const lying = {
      ...full,
      slices: { ...full.slices, gamma: bundle(7, wrong).slices.gamma },
    } as FleetBundle;
    const refused = openBundle(lying, trust, { requireFull: true });
    expect(refused.ok ? '' : refused.detail).toContain('differs from the full manifest');
    const swapped = { ...full, slices: { gamma: full.slices.edge, edge: full.slices.gamma } } as FleetBundle;
    const swap = openBundle(swapped, trust, { requireFull: true });
    expect(swap.ok ? '' : swap.detail).toContain('signed for');
    const stale = { ...full, serial: 8 };
    const staleOpening = openBundle(stale, trust, { requireFull: true });
    expect(staleOpening.ok ? '' : staleOpening.detail).toContain('edition 7');
  });

  test('an edition number is one past the newest known and never behind the clock', () => {
    expect(nextSerial(null, 1_000_000)).toBe(1000);
    expect(nextSerial(5_000, 1_000_000)).toBe(5_001);
    expect(nextSerial(10, 1_000_000)).toBe(1000);
  });
});

describe('doctor reads the bundle the way the process reports it', () => {
  const lane = status().lanes[0];
  const withBundle = (bundle: Partial<ReturnType<typeof status>['bundle']>) => ({
    ...status(),
    bundle: { ...status().bundle, ...bundle },
  });

  test('silent without fleet trust, and a verdict for each part once trust is set', () => {
    expect(bundleChecks(status())).toEqual([]);
    const aligned = bundleChecks(
      withBundle({
        copy: 'own',
        serial: 7,
        issuedAt: '2026-09-15T01:00:00.000Z',
        signer: 'signer',
        config: 'aligned',
        lanes: [
          { lane: lane?.id ?? 'primary', serial: 7, syncedAt: '2026-09-15T01:00:01.000Z', detail: null },
        ],
      }),
    );
    expect(aligned.map((check) => `${check.code}:${check.level}`)).toEqual([
      'bundle.copy:ok',
      'bundle.config:ok',
      'bundle.lane:ok',
    ]);
  });

  test('a drifted configuration fails, and a broker behind this node warns', () => {
    const checks = bundleChecks(
      withBundle({
        copy: 'full',
        serial: 9,
        signer: 'signer',
        issuedAt: '2026-09-15T01:00:00.000Z',
        config: 'drifted',
        detail: 'the projected configuration is invalid: allow: bad',
        lanes: [
          { lane: lane?.id ?? 'primary', serial: 7, syncedAt: '2026-09-15T01:00:01.000Z', detail: null },
        ],
      }),
    );
    expect(checks.find((check) => check.code === 'bundle.config')).toMatchObject({
      level: 'fail',
      detail: 'the projected configuration is invalid: allow: bad',
    });
    expect(checks.find((check) => check.code === 'bundle.lane')?.level).toBe('warn');
    const unknown = bundleChecks(
      withBundle({ config: 'unknown', detail: 'no verified fleet bundle is kept yet' }),
    );
    expect(unknown.map((check) => check.level)).toEqual(['unknown', 'unknown', 'unknown']);
  });
});

describe('rewriting a configuration never restarts a process in a loop', () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-fleet-reconcile-'));
  const brokerFile = join(root, 'broker.json');
  const raw = {
    port: 8790,
    nodes: [
      { id: 'alpha', tokenSha256s: ['a'.repeat(64)] },
      { id: 'gamma', tokenSha256s: ['c'.repeat(64)] },
    ],
  };
  const parse = (value: unknown) => {
    const parsed = BrokerConfigSchema.safeParse(value);
    return parsed.success
      ? ({ ok: true, value: parsed.data } as const)
      : ({ ok: false, detail: parsed.error.message } as const);
  };
  const run = (running: unknown) =>
    reconcile({
      path: brokerFile,
      running: BrokerConfigSchema.parse(running),
      project: (config) => applyBrokerTables(config, manifest),
      tablesOf: brokerTablesOf,
      parse,
    });

  test('a process running old tables reloads once, and the reloaded one finds nothing to do', async () => {
    writeFileSync(brokerFile, JSON.stringify(raw));
    expect(await run(raw)).toEqual({ state: 'reload', wrote: true });
    const onDisk = JSON.parse(readFileSync(brokerFile, 'utf8'));
    // The topic carries none of the defaults the schema fills in; parsed forms still compare equal.
    expect(onDisk.topics['release.gamma.lifecycle']).toEqual({
      producer: 'gamma',
      subscribers: ['alpha'],
      delivery: 'ordered',
    });
    expect(await run(onDisk)).toEqual({ state: 'aligned', wrote: false });
  });

  test('a hand edit the process never loaded is undone on disk without a reload', async () => {
    const aligned = JSON.parse(readFileSync(brokerFile, 'utf8'));
    writeFileSync(brokerFile, JSON.stringify({ ...aligned, commandGrants: [] }));
    expect(await run(aligned)).toEqual({ state: 'aligned', wrote: true });
    expect(
      sameTables(brokerTablesOf(JSON.parse(readFileSync(brokerFile, 'utf8'))), brokerTablesOf(aligned)),
    ).toBe(true);
    expect(JSON.parse(readFileSync(`${brokerFile}.before-bundle`, 'utf8')).commandGrants).toEqual([]);
  });

  test('a projection the schema refuses is reported, and the file is left alone', async () => {
    const before = readFileSync(brokerFile, 'utf8');
    const outcome = await reconcile({
      path: brokerFile,
      running: BrokerConfigSchema.parse(JSON.parse(before)),
      project: (config) => ({ ...config, topics: { 'bad topic': {} } }),
      tablesOf: brokerTablesOf,
      parse,
    });
    expect(outcome.state).toBe('drifted');
    expect(readFileSync(brokerFile, 'utf8')).toBe(before);
  });
});
