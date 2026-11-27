import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BrokerHealthContractSchema } from '../packages/contracts/src/protocol/broker-health.ts';
import { MAX_NODES } from '../packages/contracts/src/protocol/bounds.ts';
import { readBrokerHealth } from '../packages/local-client/src/broker-health.ts';
import { brokerChecks } from '../packages/runtime/src/cli/doctor-broker.ts';
import { DiagnosticReadError, readBrokerObservation } from '../packages/runtime/src/cli/doctor-read.ts';
import { brokerObservation } from '../packages/runtime/src/enrollment/observe.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';
import { brokerHealth } from './doctor-fixture.ts';

/** What a broker of the next release could write: the same answer with fields this one does not know. */
function fromNextRelease() {
  const health = brokerHealth();
  const [topic] = health.topics;
  if (!topic) throw new Error('Fixture has no topic');
  return {
    ...health,
    addedByNextRelease: { meaning: 'unknown here' },
    transport: { ...health.transport, addedField: 1 },
    fleet: { ...health.fleet, addedField: true },
    events: { ...health.events, recent: { ...health.events.recent, addedField: 0 } },
    topics: [{ ...topic, addedField: 'x', limits: { ...topic.limits, addedField: 2 } }],
    admission: { ...health.admission, addedField: 3 },
  };
}

let answer: unknown = brokerHealth();
const paths: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let lane: string;

beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname);
      return Response.json(answer);
    },
  });
  lane = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

test('the broker writes /health strictly: an undeclared field fails its own answer', () => {
  expect(BrokerHealthContractSchema.safeParse(brokerHealth()).success).toBe(true);
  expect(BrokerHealthContractSchema.safeParse(fromNextRelease()).success).toBe(false);
});

test('doctor and enrollment read a broker of the next release without refusing it', async () => {
  answer = fromNextRelease();
  const health = await readBrokerObservation(lane);
  expect(health.fleet.latest).toBe(RELEASE_VERSION);
  expect(Object.hasOwn(health, 'addedByNextRelease')).toBe(false);
  expect((await brokerObservation(lane, RELEASE_VERSION)).fleet.latest).toBe(RELEASE_VERSION);
});

test('enrollment against a broker of another release answers version-mismatch, not unavailable', async () => {
  const health = fromNextRelease();
  answer = { ...health, fleet: { ...health.fleet, latest: '999.0.0' } };
  await expect(brokerObservation(lane, RELEASE_VERSION)).rejects.toMatchObject({ code: 'version-mismatch' });
});

test('an answer without a required field is still refused, with its diagnostic code', async () => {
  const { fleet: _fleet, ...withoutFleet } = brokerHealth();
  answer = withoutFleet;
  const refusal = await readBrokerObservation(lane).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(DiagnosticReadError);
  expect(refusal).toMatchObject({ code: 'observation.schema' });
  await expect(brokerObservation(lane, RELEASE_VERSION)).rejects.toMatchObject({
    code: 'broker-unavailable',
  });
});

test('a lane URL that already names /health is read at /health, once', async () => {
  answer = brokerHealth();
  paths.length = 0;
  await readBrokerObservation(`${lane}/health`);
  await readBrokerObservation(lane);
  expect(paths).toEqual(['/health', '/health']);
});

/** A `/health` answer with every enumerated field populated, as this release writes it. */
function populated() {
  const health = brokerHealth();
  return BrokerHealthContractSchema.parse({
    ...health,
    nodes: [
      {
        nodeId: 'worker',
        online: false,
        serves: true,
        connections: 0,
        since: null,
        version: RELEASE_VERSION,
        behind: 'minor',
        versionSeenAt: '2026-09-02T06:01:41.000Z',
        departure: { at: '2026-09-02T06:01:45.000Z', reason: 'ping timeout', kind: 'lost' },
        observingSince: '2026-09-02T06:01:40.000Z',
      },
    ],
    audit: {
      ...health.audit,
      recovery: {
        filesChecked: 1,
        anomalies: 1,
        skippedBytes: 3,
        firstAnomaly: anomaly(),
        lastAnomaly: anomaly(),
        quarantined: [{ file: 'a.jsonl', quarantinedAs: 'a.jsonl.quarantined', reason: 'unreadable' }],
      },
    },
    fleet: {
      ...health.fleet,
      machines: [
        {
          nodeId: 'worker',
          online: true,
          release: { current: RELEASE_VERSION, latest: null, latestAt: null, checkedAt: null, ok: false },
          behind: 'patch',
        },
      ],
    },
  });
}

function anomaly() {
  return {
    file: 'a.jsonl',
    offset: 0,
    line: 1,
    reason: 'invalid-json',
    position: 'tail',
    terminated: true,
    skippedBytes: 3,
  };
}

/** The value at `path` replaced by `next`, on a deep copy. */
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

/** Every enumerated field of `/health`, each with a value a broker of the next release could write. */
const nextReleaseValues: { path: (string | number)[]; value: unknown }[] = [
  { path: ['nodes', 0, 'behind'], value: 'epoch' },
  { path: ['nodes', 0, 'departure', 'kind'], value: 'evicted' },
  { path: ['transport', 'eventLoopDelay', 'state'], value: 'throttled' },
  { path: ['audit', 'recovery', 'firstAnomaly', 'reason'], value: 'torn-frame' },
  { path: ['audit', 'recovery', 'firstAnomaly', 'position'], value: 'middle' },
  { path: ['audit', 'recovery', 'lastAnomaly', 'reason'], value: 'torn-frame' },
  { path: ['audit', 'recovery', 'quarantined', 0, 'reason'], value: 'oversized' },
  { path: ['fleet', 'machines', 0, 'behind'], value: 'epoch' },
  { path: ['bundle', 'config'], value: 'quarantined' },
  { path: ['topics', 0, 'source'], value: 'mirror' },
  { path: ['topics', 0, 'publicationMode'], value: 'burst' },
];

test('a value this release does not know is refused by the writer and read as unrecognized', async () => {
  for (const { path, value } of nextReleaseValues) {
    const next = replaced(populated(), path, value);
    expect({ path, writer: BrokerHealthContractSchema.safeParse(next).success }).toEqual({
      path,
      writer: false,
    });
    answer = next;
    const read = await readBrokerHealth(lane);
    expect({ path, value: path.reduce<unknown>(step, read) }).toEqual({ path, value: 'unrecognized' });
  }
  // Positive control: the same answer with this release's values reads back unchanged.
  const known = populated();
  answer = known;
  expect(await readBrokerHealth(lane)).toEqual(known);
});

test('doctor never reads an unrecognized value as ok', async () => {
  const levels = async (path: (string | number)[], value: unknown, code: string) => {
    answer = replaced(populated(), path, value);
    return brokerChecks(await readBrokerObservation(lane))
      .filter((check) => check.code === code)
      .map((check) => check.level);
  };
  const aligned = replaced(replaced(populated(), ['bundle', 'config'], 'aligned'), ['bundle', 'serial'], 3);
  answer = aligned;
  expect(brokerChecks(await readBrokerObservation(lane)).find((c) => c.code === 'broker.bundle')?.level).toBe(
    'ok',
  );
  answer = replaced(aligned, ['bundle', 'config'], 'quarantined');
  expect(brokerChecks(await readBrokerObservation(lane)).find((c) => c.code === 'broker.bundle')?.level).toBe(
    'unknown',
  );
  expect(await levels(['topics', 0, 'publicationMode'], 'burst', 'topic.publication')).toEqual(['unknown']);
  expect(
    await levels(['transport', 'eventLoopDelay', 'state'], 'throttled', 'broker.event-loop-delay'),
  ).toEqual(['unknown']);
});

test('a broker that writes no bundle, application, admission or transport block is still read', async () => {
  const { bundle: _b, application: _a, admission: _d, transport: _t, ...older } = populated();
  answer = older;
  const health = await readBrokerHealth(lane);
  expect(health.nodes.map((node) => node.nodeId)).toEqual(['worker']);
  expect(health.topics.map((topic) => topic.topic)).toEqual(['example.changed']);
  const checks = brokerChecks(await readBrokerObservation(lane));
  for (const code of [
    'broker.application',
    'broker.event-loop-delay',
    'broker.last-disconnect',
    'broker.bundle',
  ])
    expect({ code, level: checks.find((check) => check.code === code)?.level }).toEqual({
      code,
      level: 'unknown',
    });
});

test('a reader takes more nodes than one broker admits: the bound is the body, not the count', async () => {
  const [node] = populated().nodes;
  if (node === undefined) throw new Error('fixture has no node');
  answer = {
    ...populated(),
    nodes: Array.from({ length: MAX_NODES + 1 }, (_, index) => ({ ...node, nodeId: `n${index}` })),
  };
  expect((await readBrokerHealth(lane)).nodes).toHaveLength(MAX_NODES + 1);
});

test('a health body that is not strict UTF-8, or that declares more than the cap, is refused by the one JSON reader', async () => {
  const refusal = async (response: Response, maxResponseBytes?: number) => {
    const error = await readBrokerHealth(lane, { fetch: async () => response, maxResponseBytes }).catch(
      (caught: unknown) => caught,
    );
    return { code: Reflect.get(Object(error), 'code'), message: Reflect.get(Object(error), 'message') };
  };
  // A lossy decode would turn the bad byte into U+FFFD and the string into a value.
  const lossy = new Uint8Array([0x22, 0xff, 0x22]);
  expect(await refusal(new Response(lossy, { headers: { 'content-type': 'application/json' } }))).toEqual({
    code: 'invalid-response',
    message: 'Broker health response is not valid UTF-8 JSON',
  });
  const announced = new Response('{}', { headers: { 'content-length': '1048577' } });
  expect(await refusal(announced, 1024 * 1024)).toEqual({
    code: 'limit',
    message: 'Broker health response exceeds byte limit',
  });
});
