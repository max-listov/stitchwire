/**
 * Does the agent's live heap grow under traffic that never stops, and under failures that never stop?
 *
 *   bun scripts/soak-memory.ts fan-in    [--seconds 120] [--rate 200]   34 topics, `rate` events per second,
 *                                                                       each read through its own door stream
 *   bun scripts/soak-memory.ts failures  [--calls 12000] [--restarts 60] a missing owner socket, broker restarts
 *
 * Both take `--stitchkit <dir>`: another installation (a directory whose `node_modules` holds a
 * different `stitchkit`) to run the same stand on, so two versions can be compared on the same traffic.
 * The first line of the report names the Stitchkit that was measured.
 *
 * One broker and two agents run in this process on isolated sockets. After each phase the garbage
 * collector runs twice and the live JavaScript heap is read, because the process's resident size is
 * not an answer: it keeps pages the heap no longer uses, and on a host under memory pressure the
 * system takes them away without the heap changing at all. A flat live heap across phases means the
 * traffic does not leak; the `grew` entry names the object types that did not go back.
 *
 * The run ends in a verdict and its exit code. The stand must carry its traffic, and no object type
 * may keep more than a bounded number of objects per unit of work: per event delivered (`fan-in`, a slope over
 * snapshots every ten seconds), per call and per broker restart (`failures`, two snapshots). Every
 * measure starts after a warm-up share of the same work, so what the first units compile and cache
 * once is not counted as kept. A leak keeps at least one object per unit; the bounds sit under that.
 */
import { heapStats } from 'bun:jsc';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createWireClient } from '../packages/client/src/index.ts';
import type { ServiceGrant } from '../packages/contracts/src/service/policy-schema.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { brokerConfig, brokerHealth, freePort, until, waitConnected } from '../test/support.ts';
import { stitchkitOverride, stitchkitVersion } from './soak-stitchkit.ts';

const { positionals, values, tokens } = parseArgs({
  allowPositionals: true,
  tokens: true,
  options: {
    seconds: { type: 'string', default: '120' },
    rate: { type: 'string', default: '200' },
    calls: { type: 'string', default: '12000' },
    restarts: { type: 'string', default: '60' },
    stitchkit: { type: 'string' },
  },
});
const mode = positionals[0];
if (mode !== 'fan-in' && mode !== 'failures') throw new Error('usage: soak-memory.ts fan-in|failures');

/** Set in the re-run under `--stitchkit`: the installation whose Stitchkit this run is measuring. */
const ALTERNATIVE_VARIABLE = 'SOAK_STITCHKIT_FROM';

/**
 * `--stitchkit <dir>` runs this same script again under a tsconfig that sends `stitchkit` to the
 * installation in `<dir>`: an import cannot be redirected after the module that makes it has loaded.
 */
if (values.stitchkit !== undefined && process.env[ALTERNATIVE_VARIABLE] === undefined) {
  const from = resolve(values.stitchkit);
  // Both `--stitchkit <dir>` and `--stitchkit=<dir>` leave the arguments; the token knows which one it was.
  const option = tokens.find((token) => token.kind === 'option' && token.name === 'stitchkit');
  const argv = process.argv.slice(2);
  if (option?.kind === 'option') argv.splice(option.index, option.inlineValue === undefined ? 2 : 1);
  const override = join(await mkdtemp(join(tmpdir(), 'wire-soak-override-')), 'tsconfig.json');
  await writeFile(override, stitchkitOverride(from));
  const child = Bun.spawn(['bun', `--tsconfig-override=${override}`, import.meta.path, ...argv], {
    stdio: ['inherit', 'inherit', 'inherit'],
    env: { ...process.env, [ALTERNATIVE_VARIABLE]: from },
  });
  const code = await child.exited;
  await rm(dirname(override), { recursive: true, force: true });
  process.exit(code);
}
console.log(JSON.stringify({ stitchkit: stitchkitVersion(process.env[ALTERNATIVE_VARIABLE]), mode }));

/** A positive whole number, or the run stops: `--calls abc` would otherwise make no calls and look like a pass. */
function count(name: keyof typeof values): number {
  const value = Number(values[name]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--${name} must be a positive whole number`);
  return value;
}

/**
 * How many objects of one type a phase may keep: a constant the collector leaves either way, plus a
 * slope per unit of work. A leak keeps at least one object per unit, so at the default run sizes it
 * exceeds the bound, and the constant is what a run of the fixed stand measured as its noise.
 */
const KEPT_PER_CALL = { constant: 3_000, perUnit: 0.2 };
/**
 * Measured on Stitchkit 0.111.1 (2026-10-17): the first calls fill a bounded store (`string` and
 * `Object` grow with the warm-up: +5 103 strings after 1 200 calls, +7 689 after 2 400) and the
 * count is flat once it is full (+56 objects over the 21 600 calls after a 2 400-call warm-up).
 */
const WARM_UP_CALLS = 3_000;
const KEPT_PER_RESTART = { constant: 1_000, perUnit: 20 };
/**
 * Under steady fan-in the live heap saws up and down by thousands of objects between collections,
 * so two snapshots cannot tell a leak from the saw. The verdict fits each type's count against the
 * events delivered across the snapshots after the warm-up and bounds the steepest slope: a leak keeps
 * at least one object per event, the fixed stand none.
 *
 * Measured on Stitchkit 0.111.1 (2026-10-17, this stand at 200 events/s): `Object` grows by one per
 * event until about 12 000 events and is flat after that (211 244 → 211 187 objects from 12 400 to
 * 24 000 events), so the warm-up is counted in events, not in time, and ends past that fill.
 */
const KEPT_PER_EVENT_SLOPE = 0.3;
const FAN_IN_WARM_UP_EVENTS = 15_000;
const FAN_IN_SAMPLE_MS = 10_000;
/** Fewer snapshots after the warm-up than this fit a line to noise; the verdict then fails as too short. */
const FAN_IN_MIN_SAMPLES = 4;
/** How a call to a binding whose owner socket does not exist ends. */
const OWNER_MISSING = 'unavailable';

/**
 * The run's size is checked before anything starts: a run too small to leave samples after its warm-up
 * would build the whole stand, spend its seconds and only then fail as "too short".
 */
function validateInput(): void {
  if (mode === 'fan-in') {
    const rate = count('rate');
    const seconds = count('seconds');
    if (rate < 10)
      throw new Error('--rate must be at least 10: events are published in batches every 100 ms');
    // The warm-up is counted in events, and the verdict needs samples every FAN_IN_SAMPLE_MS after it:
    // the first sample ends the warm-up, then FAN_IN_MIN_SAMPLES - 2 more, then the closing one.
    const warmSeconds = FAN_IN_WARM_UP_EVENTS / rate;
    const neededSeconds = Math.ceil(warmSeconds + ((FAN_IN_MIN_SAMPLES - 2) * FAN_IN_SAMPLE_MS) / 1000);
    if (seconds < neededSeconds)
      throw new Error(
        `--seconds ${seconds} at --rate ${rate} leaves too few samples after the ${FAN_IN_WARM_UP_EVENTS}-event warm-up: at least ${neededSeconds} seconds are needed`,
      );
  } else {
    if (count('calls') <= WARM_UP_CALLS)
      throw new Error(`--calls must exceed the ${WARM_UP_CALLS}-call warm-up`);
    // The restart verdict is measured over the restarts after the first, which is its warm-up.
    if (count('restarts') < 2) throw new Error('--restarts must be at least 2: the first is a warm-up');
  }
}
validateInput();

const TOPICS = Array.from({ length: 34 }, (_, index) => `soak.t${index}`);
const root = await mkdtemp(join(tmpdir(), 'wire-soak-'));
await mkdir(join(root, 'own'), { mode: 0o700 });
const token = crypto.randomUUID() + crypto.randomUUID();
const port = freePort();

const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 };
/** The owner binding's concurrency; the failures phase calls exactly this many at once. */
const BINDING_INFLIGHT = 4;
const descriptor = {
  service: 'soak.service',
  revision: '1',
  maxInflight: BINDING_INFLIGHT,
  operations: [{ id: 'read', path: '/soak/read', effect: 'read', limits, response: { kind: 'unary' } }],
};
await writeFile(join(root, 'descriptor.json'), JSON.stringify(descriptor));
const grants: ServiceGrant[] = [
  { caller: 'reader', target: 'worker', service: 'soak.service', scope: { kind: 'service-read' } },
];
const standBroker = () =>
  brokerConfig(
    { worker: token, reader: token },
    {
      port,
      serviceGrants: grants,
      auditPath: join(root, 'audit.jsonl'),
      capabilities: {
        reader: [{ operation: 'subscribe', targets: ['worker'] }],
        worker: [{ operation: 'publish', targets: ['worker'] }],
      },
      topics: Object.fromEntries(
        TOPICS.map((topic, index) => [
          topic,
          index % 2 === 0
            ? {
                producer: 'worker',
                subscribers: ['reader'],
                delivery: 'ordered',
                retain: { maxAgeMs: 60_000, maxBytes: 65_536 },
              }
            : { producer: 'worker', subscribers: ['reader'], delivery: 'latest-wins' },
        ]),
      ),
    },
  );
let broker = await startBroker(standBroker());
const brokers = [
  { id: 'primary', url: `http://127.0.0.1:${port}`, token, reconnect: { minDelayMs: 100, maxDelayMs: 300 } },
];
const worker = await startAgent(
  NodeConfigSchema.parse({
    nodeId: 'worker',
    brokers,
    agentSocket: join(root, 'worker.sock'),
    events: { publish: TOPICS, subscribe: [] },
    admission: { maxPublishesPerMinute: 60_000, maxPendingPublishes: 256 },
    services: {
      grants,
      bindings: [
        {
          service: 'soak.service',
          descriptorPath: join(root, 'descriptor.json'),
          socketPath: join(root, 'own/missing.sock'),
          endpointPath: '/invoke',
          maxInflight: BINDING_INFLIGHT,
          limits,
        },
      ],
    },
  }),
);
const reader = await startAgent(
  NodeConfigSchema.parse({
    nodeId: 'reader',
    brokers,
    agentSocket: join(root, 'reader.sock'),
    events: { publish: [], subscribe: TOPICS },
    admission: { maxEventSubscriptions: 64 },
  }),
);
await waitConnected(worker, reader);
const publisher = createWireClient({ socketPath: join(root, 'worker.sock') });
const subscriber = createWireClient({ socketPath: join(root, 'reader.sock') });

type Types = Record<string, number>;
let previous: Types = {};
/** The live heap after a full collection, and which types grew since the previous snapshot. */
function snapshot(label: string): Types {
  Bun.gc(true);
  Bun.gc(true);
  const heap = heapStats();
  console.log(
    JSON.stringify({
      label,
      residentMB: Math.round(process.memoryUsage().rss / 1_048_576),
      liveHeapMB: Math.round(heap.heapSize / 1_048_576),
      objects: heap.objectCount,
      since: grew(previous, heap.objectTypeCounts).slice(0, 5),
    }),
  );
  previous = heap.objectTypeCounts;
  return heap.objectTypeCounts;
}
function deltas(before: Types, after: Types): Array<[string, number]> {
  return Object.entries(after)
    .map(([type, count]): [string, number] => [type, count - (before[type] ?? 0)])
    .sort((left, right) => right[1] - left[1]);
}
function grew(before: Types, after: Types): Array<[string, number]> {
  return deltas(before, after)
    .filter(([, delta]) => delta > 200)
    .slice(0, 8);
}

const verdicts: Array<{ check: string; ok: boolean; [detail: string]: unknown }> = [];
/** The least-squares slope of each type's count over `units`, steepest first. */
function slopes(samples: ReadonlyArray<{ units: number; types: Types }>): Array<[string, number]> {
  const mean = samples.reduce((sum, sample) => sum + sample.units, 0) / samples.length;
  const spread = samples.reduce((sum, sample) => sum + (sample.units - mean) ** 2, 0);
  const types = new Set(samples.flatMap((sample) => Object.keys(sample.types)));
  return [...types]
    .map((type): [string, number] => {
      const level = samples.reduce((sum, sample) => sum + (sample.types[type] ?? 0), 0) / samples.length;
      const covariance = samples.reduce(
        (sum, sample) => sum + (sample.units - mean) * ((sample.types[type] ?? 0) - level),
        0,
      );
      return [type, spread > 0 ? covariance / spread : 0];
    })
    .sort((left, right) => right[1] - left[1]);
}

/** The type that grew most between two snapshots must stay inside the phase's bound for its units. */
function retained(
  check: string,
  before: Types,
  after: Types,
  units: number,
  kept: { constant: number; perUnit: number },
): void {
  const [type = 'none', delta = 0] = deltas(before, after)[0] ?? [];
  const bound = kept.constant + kept.perUnit * units;
  verdicts.push({ check, ok: units > 0 && delta <= bound, type, delta, units, bound });
}

let received = 0;
let gaps = 0;
let errors = 0;
let refused = 0;
const clients: Array<ReturnType<typeof createWireClient>> = [];
const start = snapshot('baseline');

try {
  if (mode === 'fan-in') {
    // One client per subscription: a client admits a bounded number of concurrent operations, and a
    // stand with more topics than that would end up measuring refusals.
    for (const topic of TOPICS)
      void (async () => {
        const own = createWireClient({ socketPath: join(root, 'reader.sock') });
        clients.push(own);
        for await (const item of own.subscribe({ topic })) {
          // Only an event is a delivery: a gap is a loss and an error ends the subscription.
          if (item.kind === 'event') received += 1;
          else if (item.kind === 'gap') gaps += 1;
          else errors += 1;
        }
      })().catch(() => {});
    // Publishing starts once the broker holds every subscription; an event before that is not delivered.
    if (!(await until(async () => (await brokerHealth(port)).events.subscriptions === TOPICS.length)))
      throw new Error('the stand did not open its subscriptions');
    snapshot('subscriptions open');
    const bootId = crypto.randomUUID();
    const sequence = new Map<string, number>();
    const batch = Math.max(1, Math.round(count('rate') / 10));
    const seconds = count('seconds');
    const began = Date.now();
    let published = 0;
    let ticks = 0;
    let sampleAt = 0;
    const samples: Array<{ units: number; types: Types }> = [];
    while (Date.now() - began < seconds * 1000) {
      const data = crypto.randomUUID().repeat(28);
      await Promise.all(
        Array.from({ length: batch }, async (_, offset) => {
          const topic = TOPICS[(published + offset) % TOPICS.length] ?? 'soak.t0';
          const seq = sequence.get(topic) ?? 0;
          sequence.set(topic, seq + 1);
          if (!(await publisher.publish({ topic, bootId, seq, data })).ok) refused += 1;
        }),
      );
      published += batch;
      // One batch every 100 ms on the clock, not 100 ms after the batch ended, so `--rate` is the rate.
      ticks += 1;
      await Bun.sleep(Math.max(0, began + ticks * 100 - Date.now()));
      if (received >= FAN_IN_WARM_UP_EVENTS && Date.now() - began >= sampleAt) {
        const label = samples.length === 0 ? 'warm' : 'sample';
        samples.push({
          units: received,
          types: snapshot(`${label}, ${published} published, ${received} received`),
        });
        sampleAt = Date.now() - began + FAN_IN_SAMPLE_MS;
      }
    }
    await until(() => received >= published);
    const end = snapshot(`end, ${published} published, ${received} received`);
    console.log(JSON.stringify({ grew: grew(start, end) }));
    // A stand that delivers little measures nothing: events refused at an admission ceiling never reach
    // a subscriber, and the heap stays flat for that reason alone.
    verdicts.push({
      check: 'traffic carried',
      ok: refused === 0 && errors === 0 && received >= published * 0.99,
      published,
      received,
      gaps,
      errors,
      refused,
    });
    samples.push({ units: received, types: end });
    const [steepest = 'none', slope = 0] = slopes(samples)[0] ?? [];
    verdicts.push({
      check: 'objects kept per event delivered',
      ok: samples.length >= FAN_IN_MIN_SAMPLES && slope <= KEPT_PER_EVENT_SLOPE,
      type: steepest,
      slope,
      samples: samples.length,
      bound: KEPT_PER_EVENT_SLOPE,
    });
  } else {
    const outcomes = new Map<string, number>();
    const call = async () => {
      const answer = await subscriber.invokeService({
        to: 'worker',
        service: 'soak.service',
        revision: '1',
        operation: 'read',
        payload: '{}',
        timeoutMs: 2000,
      });
      const key = answer.outcome.status === 'failure' ? answer.outcome.code : answer.outcome.status;
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    };
    // As many calls at once as the binding admits: more would be refused at its ceiling and never
    // reach the missing owner this soak is about.
    const batches = async (total: number) => {
      for (let done = 0; done < total; done += BINDING_INFLIGHT)
        await Promise.all(Array.from({ length: Math.min(BINDING_INFLIGHT, total - done) }, call));
    };
    const calls = count('calls');
    const warmCalls = WARM_UP_CALLS;
    await batches(warmCalls);
    const warmedCalls = snapshot(`after ${warmCalls} warm-up calls`);
    await batches(calls - warmCalls);
    const afterCalls = snapshot(`after ${calls} calls to a missing owner socket`);
    // The restart cadence is the workload: each pause is the stand's own rhythm, not a wait for a state.
    const restart = async () => {
      await broker.stop();
      await Bun.sleep(30);
      broker = await startBroker(standBroker());
      await Bun.sleep(150);
    };
    const restarts = count('restarts');
    await restart();
    await waitConnected(worker, reader);
    const warmedRestarts = snapshot('after a warm-up broker restart');
    for (let index = 1; index < restarts; index++) await restart();
    await waitConnected(worker, reader);
    const afterRestarts = snapshot(`after ${restarts} broker restarts`);
    console.log(
      JSON.stringify({
        outcomes: Object.fromEntries(outcomes),
        grewAfterCalls: grew(start, afterCalls),
        grewAfterRestarts: grew(warmedRestarts, afterRestarts),
      }),
    );
    // Every call must reach the worker and fail there on the missing owner; a call refused before it
    // (admission, policy) exercises nothing this soak is about.
    verdicts.push({
      check: 'calls reached the missing owner',
      ok: [...outcomes.keys()].every((key) => key === OWNER_MISSING),
      outcomes: Object.fromEntries(outcomes),
    });
    retained('objects kept per call', warmedCalls, afterCalls, calls - warmCalls, KEPT_PER_CALL);
    retained(
      'objects kept per broker restart',
      warmedRestarts,
      afterRestarts,
      restarts - 1,
      KEPT_PER_RESTART,
    );
  }
} finally {
  publisher.close();
  subscriber.close();
  for (const own of clients) own.close();
  await worker.stop();
  await reader.stop();
  await broker.stop();
  await rm(root, { recursive: true, force: true });
}
const passed = verdicts.length > 0 && verdicts.every((verdict) => verdict.ok);
console.log(JSON.stringify({ verdict: passed ? 'pass' : 'fail', checks: verdicts }));
process.exit(passed ? 0 : 1);
