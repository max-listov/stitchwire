import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindUnixSocket } from 'stitchkit/files';
import { z } from 'zod';
import { LocalStatusSchema } from '../packages/contracts/src/door/status.ts';
import { EnrollmentNodeRequestSchema } from '../packages/contracts/src/enrollment/request.ts';
import { EventLoopDelaySnapshotSchema } from '../packages/contracts/src/protocol/broker-health.ts';
import { MAX_NODES } from '../packages/contracts/src/protocol/bounds.ts';
import { createWireClient } from '../packages/local-client/src/client.ts';
import { BrokerHealthSchema, StatusResultSchema } from '../packages/local-client/src/contracts.ts';
import { nodeChecks } from '../packages/runtime/src/cli/doctor-node.ts';
import { nodeObservation } from '../packages/runtime/src/enrollment/observe.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';
import { status } from './doctor-fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'wire-status-reader-'));
const socketPath = join(root, 'agent.sock');
let answer: unknown;
let door: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  door = bindUnixSocket({ path: socketPath, mode: 0o600 }, () =>
    Bun.serve({ unix: socketPath, fetch: () => Response.json(answer) }),
  );
});
afterAll(() => {
  door.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const now = '2026-09-02T06:01:40.000Z';
const anomaly = {
  file: 'a.jsonl',
  offset: 0,
  line: 1,
  reason: 'invalid-json',
  position: 'tail',
  terminated: true,
  skippedBytes: 3,
};
const recovery = {
  filesChecked: 1,
  anomalies: 1,
  skippedBytes: 3,
  firstAnomaly: anomaly,
  lastAnomaly: anomaly,
  quarantined: [{ file: 'a.jsonl', quarantinedAs: 'a.jsonl.quarantined', reason: 'unreadable' }],
};
const profile = { name: 'job', path: '/bin/true', present: true, cwd: null, cwdPresent: true, timeoutMs: 1 };

/** A `/status` answer with every enumerated field populated, as this release writes it. */
function populated() {
  const base = status();
  return LocalStatusSchema.parse({
    ...base,
    publicationAudit: { ...base.publicationAudit, recovery },
    serviceAudit: { ...base.publicationAudit, recovery },
    allow: [{ ...profile, callerArgs: 'none', stdin: 'none', outputBytes: 1, concurrency: 1 }],
    streams: [{ ...profile, format: 'raw', stableCursor: false, maxBytes: 1, concurrency: 1 }],
    events: {
      ...base.events,
      declarations: {
        ...base.events.declarations,
        descriptors: [{ path: '/d/topics.json', state: 'loaded', topics: 1, detail: null }],
      },
    },
    services: {
      ...base.services,
      declarations: {
        ...base.services.declarations,
        descriptors: [
          { path: '/d/svc.json', state: 'loaded', service: 'owner.svc', callers: 1, detail: null },
        ],
      },
    },
    bundle: { ...base.bundle, config: 'aligned', copy: 'own', serial: 3, signer: 'fleet-key', issuedAt: now },
    nodes: [
      {
        nodeId: 'worker',
        online: false,
        serves: true,
        connections: 0,
        since: null,
        version: base.version,
        behind: 'minor',
        versionSeenAt: now,
        departure: { at: now, reason: 'ping timeout', kind: 'lost' },
        observingSince: now,
      },
    ],
  });
}

function replaced(value: unknown, path: readonly (string | number)[], next: unknown): unknown {
  const copy = structuredClone(value);
  const last = path.at(-1);
  const parent = path.slice(0, -1).reduce<unknown>(step, copy);
  if (last === undefined || typeof parent !== 'object' || parent === null) throw new Error('bad path');
  Reflect.set(parent, last, next);
  return copy;
}

function step(cursor: unknown, key: string | number): unknown {
  if (typeof cursor !== 'object' || cursor === null) throw new Error(`no ${key}`);
  return Reflect.get(cursor, key);
}

/** Every enumerated field of `/status`, each with a value an agent of the next release could write. */
const nextReleaseValues: (string | number)[][] = [
  ['lanes', 0, 'presence'],
  ['publicationAudit', 'recovery', 'firstAnomaly', 'reason'],
  ['publicationAudit', 'recovery', 'firstAnomaly', 'position'],
  ['publicationAudit', 'recovery', 'lastAnomaly', 'reason'],
  ['publicationAudit', 'recovery', 'quarantined', 0, 'reason'],
  ['serviceAudit', 'recovery', 'lastAnomaly', 'position'],
  ['allow', 0, 'callerArgs'],
  ['allow', 0, 'stdin'],
  ['streams', 0, 'format'],
  ['events', 'declarations', 'descriptors', 0, 'state'],
  ['services', 'declarations', 'descriptors', 0, 'state'],
  ['bundle', 'config'],
  ['bundle', 'copy'],
  ['nodes', 0, 'behind'],
  ['nodes', 0, 'departure', 'kind'],
];

test('the SDK reads a value this release does not know as unrecognized; the writer refuses it', async () => {
  const client = createWireClient({ socketPath });
  try {
    for (const path of nextReleaseValues) {
      const next = replaced(populated(), path, 'from-the-next-release');
      expect({ path, writer: LocalStatusSchema.safeParse(next).success }).toEqual({ path, writer: false });
      answer = next;
      const read = await client.status();
      expect({ path, value: path.reduce<unknown>(step, read) }).toEqual({ path, value: 'unrecognized' });
    }
    // Positive control: this release's values read back as written.
    const known = populated();
    answer = known;
    expect(await client.status()).toEqual(known);
  } finally {
    client.close();
  }
});

test('enrollment reads its own release strictly and refuses an unknown value', async () => {
  const request = EnrollmentNodeRequestSchema.parse({
    v: 1,
    kind: 'node',
    requestId: crypto.randomUUID(),
    nodeId: 'reader',
    expectedVersion: RELEASE_VERSION,
    config: '/selected/node.json',
    material: '/selected/material.json',
    brokers: [{ id: 'primary', url: 'https://broker.example.test' }],
    agentSocket: socketPath,
    supervisor: { kind: 'existing' },
    owner: { id: 'first', descriptors: [] },
  });
  answer = populated();
  expect((await nodeObservation(request))?.nodeId).toBe('reader');
  answer = replaced(populated(), ['bundle', 'config'], 'from-the-next-release');
  await expect(nodeObservation(request)).rejects.toMatchObject({
    code: 'runtime-unavailable',
  });
});

test('doctor never reads an unrecognized value as ok', async () => {
  const client = createWireClient({ socketPath });
  const levels = async (path: (string | number)[], code: string) => {
    answer = replaced(populated(), path, 'from-the-next-release');
    return nodeChecks(await client.status(), '/selected/node.json')
      .filter((check) => check.code === code)
      .map((check) => check.level);
  };
  try {
    answer = populated();
    const known = nodeChecks(await client.status(), '/selected/node.json');
    for (const code of ['bundle.config', 'topics.descriptor', 'services.descriptor'])
      expect({ code, levels: known.filter((c) => c.code === code).map((c) => c.level) }).toEqual({
        code,
        levels: ['ok'],
      });
    expect(await levels(['bundle', 'config'], 'bundle.config')).toEqual(['unknown']);
    expect(await levels(['events', 'declarations', 'descriptors', 0, 'state'], 'topics.descriptor')).toEqual([
      'unknown',
    ]);
    expect(
      await levels(['services', 'declarations', 'descriptors', 0, 'state'], 'services.descriptor'),
    ).toEqual(['unknown']);
  } finally {
    client.close();
  }
});

test('the SDK reads more nodes than one broker admits: the bound is the body, not the count', async () => {
  const client = createWireClient({ socketPath });
  try {
    const [node] = populated().nodes;
    if (node === undefined) throw new Error('fixture has no node');
    answer = {
      ...populated(),
      nodes: Array.from({ length: MAX_NODES + 1 }, (_, index) => ({ ...node, nodeId: `n${index}` })),
    };
    expect((await client.status()).nodes).toHaveLength(MAX_NODES + 1);
  } finally {
    client.close();
  }
});

/**
 * Every closed set left in a reader, by path. A reader inherits the writer's fields, so an enum the
 * writer adds later would silently close the reader again; this walks the reader's input schema and
 * names each one. A closed set is tolerated only beside an open string in the same union — directly,
 * or as the same property of another union member. The API version literal is the only closed value
 * a reader keeps on purpose.
 */
function closedSets(schema: z.ZodType): string[] {
  const found: string[] = [];
  const entries = (node: unknown): [string, unknown][] =>
    typeof node === 'object' && node !== null ? Object.entries(node) : [];
  const field = (node: unknown, key: string): unknown =>
    typeof node === 'object' && node !== null ? Reflect.get(node, key) : undefined;
  const isOpenString = (node: unknown): boolean =>
    field(node, 'type') === 'string' &&
    field(node, 'enum') === undefined &&
    field(node, 'const') === undefined;
  const walk = (
    node: unknown,
    path: string,
    tolerated: boolean,
    openProperties: ReadonlySet<string>,
  ): void => {
    if (!tolerated && (field(node, 'enum') !== undefined || field(node, 'const') !== undefined))
      found.push(path);
    for (const [key, child] of entries(field(node, 'properties')))
      walk(child, `${path}.${key}`, openProperties.has(key), new Set());
    const items = field(node, 'items');
    if (items !== undefined) walk(items, path, false, new Set());
    const options = field(node, 'anyOf');
    if (!Array.isArray(options)) return;
    const direct = options.some(isOpenString);
    const open = new Set(
      options.flatMap((option) =>
        entries(field(option, 'properties'))
          .filter(([, child]) => isOpenString(child))
          .map(([key]) => key),
      ),
    );
    for (const option of options) walk(option, path, direct, open);
  };
  walk(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), '', false, new Set());
  return found;
}

test('no reader of /status or /health keeps a closed set the writer could grow', () => {
  expect(closedSets(StatusResultSchema)).toEqual(['.v']);
  expect(closedSets(BrokerHealthSchema)).toEqual([]);
  // Negative control: the strict writer is full of closed sets, and the walk finds them.
  expect(closedSets(LocalStatusSchema).length).toBeGreaterThan(10);
});

/** One answer per event-loop delay state the broker writes; a state the writer adds needs its own here. */
const delaySamples: Record<string, unknown> = {
  unknown: { state: 'unknown', sampledAt: null, lastMs: null, maxMs: null, windowMs: 60_000 },
  measured: { state: 'measured', sampledAt: now, lastMs: 1.5, maxMs: 9, windowMs: 60_000 },
};

test('every event-loop delay state the broker writes is read as itself, never as unrecognized', () => {
  const writerStates = EventLoopDelaySnapshotSchema.options.map((option) => option.shape.state.value);
  expect(Object.keys(delaySamples).sort()).toEqual([...writerStates].sort());
  const transport = BrokerHealthSchema.shape.transport.unwrap();
  for (const state of writerStates) {
    const written = EventLoopDelaySnapshotSchema.parse(delaySamples[state]);
    expect(transport.shape.eventLoopDelay.parse(written)).toEqual(written);
  }
  // Negative control: a state no writer of this release sends is the fact alone.
  expect(transport.shape.eventLoopDelay.parse({ state: 'saturated', lagMs: 3 })).toEqual({
    state: 'unrecognized',
  });
});
