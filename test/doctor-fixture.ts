import { test } from 'bun:test';
import { join } from 'node:path';
import { LocalStatusSchema } from '../packages/contracts/src/door/status.ts';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';

const CLI =
  process.env.WIRE_DOCTOR_TEST_ARTIFACT ?? join(import.meta.dir, '../packages/runtime/src/cli/main.ts');
export function status() {
  return LocalStatusSchema.parse({
    v: LOCAL_API_VERSION,
    nodeId: 'reader',
    connected: true,
    serves: false,
    lanes: [
      {
        id: 'primary',
        url: 'https://broker.invalid',
        connected: true,
        eventSubscriptions: { observedAt: new Date().toISOString(), activeSubscriptions: 0 },
        serves: false,
        nodesVisible: 1,
        presence: 'ready',
        lastFailure: null,
      },
    ],
    version: RELEASE_VERSION,
    allow: [],
    streams: [],
    nodes: [],
    config: { path: '/selected/node.json', mode: '600' },
    events: {
      publish: [],
      subscribe: [],
      namespaces: { publish: [], subscribe: [] },
      declarations: { descriptors: [], refused: [], lanes: [] },
      activeSubscriptions: 0,
      pendingPublishes: 0,
      observedAt: new Date().toISOString(),
      subscriptions: [],
      topics: [],
    },
    services: { namespaces: [], declarations: { descriptors: [], refused: [], lanes: [] } },
    bundle: {
      copy: 'none',
      serial: null,
      issuedAt: null,
      signer: null,
      config: 'unconfigured',
      detail: null,
      checkedAt: null,
      lanes: [],
    },
    admission: {
      maxInflight: 32,
      maxCallsPerMinute: 120,
      maxStreamProducers: 8,
      maxStreamConsumers: 8,
      maxStreamBufferedBytes: 4096,
      maxEventSubscriptions: 32,
      maxPendingPublishes: 8,
      maxPublishesPerMinute: 120,
    },
    release: {
      current: RELEASE_VERSION,
      latest: RELEASE_VERSION,
      latestAt: null,
      checkedAt: new Date().toISOString(),
      ok: true,
    },
    application: {
      id: 'example',
      lifecycle: 'running',
      ready: true,
      health: 'healthy',
      capturedAt: new Date().toISOString(),
      resources: { total: 1, ready: 1, degraded: 0, failed: 0 },
    },
    publicationAudit: {
      queued: 0,
      dropped: 0,
      writeFailures: 0,
      lastFailure: null,
      journal: { path: '/unused', bytes: 0, generations: 0, maxBytes: 4096, keep: 1, rotations: 0 },
    },
  });
}

/**
 * The hang guard of ONE doctor spawn. A test's own timeout must never fire before the guards of the
 * spawns inside it have had their turn: when it does, bun kills the test with SIGTERM (143) in the
 * middle of a passing spawn and reports a timeout that names no step. That is exactly how these
 * tests failed the isolated gate of 0.52.0 (attempt 418a1c66) — reproduced on 2026-11-12 under
 * CPU oversubscription (36 busy loops on 18 cores): "explicit config…" ran out of the default 5 s
 * with two spawns that take 0.38 s idle, and the transport test ran out of 15 s with eleven
 * spawns that take 3.9 s idle. Budgets measured on an idle machine are the treadmill; the budget
 * below follows from the guard instead.
 */
export const SPAWN_GUARD_MS = 8000;
/**
 * A doctor test whose ceiling follows from what it spawns: every spawn may use its whole guard, plus
 * any wait a spawn makes by design, plus the test's own setup.
 */
export function doctorTest(name: string, spawns: number, run: () => Promise<void>, waitMs = 0): void {
  test(name, run, spawns * SPAWN_GUARD_MS + waitMs + 5000);
}

/** `waitMs` is time the spawn spends waiting by design; its guard starts counting after it. */
export async function cli(
  args: string[],
  socket: string,
  root: string,
  config = join(root, 'config'),
  waitMs = 0,
) {
  const proc = Bun.spawn([process.execPath, CLI, 'doctor', ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      STITCHWIRE_AGENT_SOCKET: socket,
      STITCHWIRE_CONFIG_DIR: config,
      STITCHWIRE_STATE_DIR: root,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    proc.kill('SIGKILL');
  }, SPAWN_GUARD_MS + waitMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (hung)
      throw new Error(
        `doctor ${args.join(' ')} exceeded its ${(SPAWN_GUARD_MS + waitMs) / 1000}s spawn guard`,
      );
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** A broker `/health` answer of this release, as the broker writes it. */
export function brokerHealth() {
  return {
    ok: true,
    nodes: [],
    observingSince: '2026-09-02T06:01:40.000Z',
    transport: {
      broker: '127.0.0.1:8790',
      lastDisconnect: {
        nodeId: 'worker',
        reason: 'ping timeout',
        observedAt: '2026-09-02T06:01:45.000Z',
      },
      eventLoopDelay: {
        state: 'measured',
        sampledAt: '2026-09-02T06:01:46.000Z',
        lastMs: 2,
        maxMs: 7,
        windowMs: 300_000,
      },
    },
    application: status().application,
    bundle: {
      serial: null,
      issuedAt: null,
      signer: null,
      config: 'unconfigured',
      detail: null,
      checkedAt: null,
    },
    streams: { active: 0 },
    fleet: { latest: RELEASE_VERSION, latestAt: null, machines: [] },
    audit: {
      queued: 0,
      dropped: 0,
      writeFailures: 0,
      lastFailure: null,
      journal: { path: '/unused', bytes: 0, maxBytes: 1000, keep: 1, generations: 0, rotations: 0 },
    },
    events: { accepted: 1000, subscriptions: 2, topics: 1, recent: { count: 5, windowMs: 12345 } },
    topics: [
      {
        topic: 'example.changed',
        source: 'fleet',
        producer: 'writer',
        publisherLive: true,
        sinceLastPublishMs: 999999,
        cadence: { count: 10, windowMs: 60000 },
        publicationMode: 'on-change',
        rejectedPublishes: 2,
        sinceLastRejectionMs: 1000000,
        subscribers: 1,
        limits: { maxSubscribers: 8, maxEventsPerSecond: 10, maxEventBytes: 1024 },
        retention: null,
      },
    ],
    admission: {
      maxInflightPerNode: 32,
      maxCallsPerMinutePerNode: 100,
      maxStreamsTotal: 32,
      maxStreamsPerCaller: 8,
      maxStreamsPerProducer: 8,
      maxStreamOpensPerMinute: 100,
      maxEventSubscriptionsTotal: 128,
      maxEventSubscribesPerMinute: 100,
    },
  };
}
