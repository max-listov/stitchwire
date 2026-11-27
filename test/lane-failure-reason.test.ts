/**
 * A lane that is down has to say why.
 *
 * On 2026-09-01 a host firewall dropped this machine's address and every node report said exactly
 * `lane: dev: down`. Seven probes later the cause turned out to be a banned IP — and the agent had
 * known all along: socket.io had handed it the dial error, which went to stderr and nowhere else.
 *
 * The reason a refused dial is the interesting case is that it produces NO `disconnect` event at
 * all. A lane that never connects never disconnects, so the only place the fact exists is the
 * connect-error path; a test that merely drops an established connection would pass while the
 * blocked-lane case stayed silent. That is why the first test dials a port nothing listens on.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { LocalStatus } from '../packages/contracts/src/door/status.ts';
import type { BrokerHandle } from '../packages/runtime/src/broker/contracts.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { nodeChecks } from '../packages/runtime/src/cli/doctor-node.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent, AgentStatus } from '../packages/runtime/src/node/agent-contract.ts';
import { laneStatus } from '../packages/runtime/src/node/lane-status.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { temporaryFile } from './temporary.ts';
import { brokerConfig, freePort, until } from './support.ts';

const PORT = freePort();
const UNREACHABLE = freePort();
const TOKEN = 'reason-token'.padEnd(40, 'r');

let broker: BrokerHandle;
let blocked: Agent;
let admitted: Agent;

beforeAll(async () => {
  broker = await startBroker(
    brokerConfig(
      { probe: TOKEN },
      {
        port: PORT,
        auditPath: temporaryFile('reason-audit.jsonl'),
      },
    ),
  );
  blocked = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'probe',
      brokers: [
        {
          id: 'dev',
          url: `http://127.0.0.1:${UNREACHABLE}`,
          token: TOKEN,
          reconnect: { minDelayMs: 100, maxDelayMs: 200 },
        },
      ],
    }),
  );
  admitted = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'probe',
      brokers: [{ id: 'dev', url: `http://127.0.0.1:${PORT}`, token: TOKEN }],
    }),
  );
});

afterAll(async () => {
  await blocked.stop();
  await admitted.stop();
  await broker.stop();
});

type LaneReport = Awaited<ReturnType<Agent['status']>>['lanes'][number];

function observed(status: AgentStatus): LocalStatus {
  return {
    ...status,
    publicationAudit: {
      queued: 0,
      dropped: 0,
      writeFailures: 0,
      lastFailure: null,
      journal: {
        path: '/state/audit.jsonl',
        bytes: 0,
        generations: 1,
        maxBytes: 1024,
        keep: 1,
        rotations: 0,
      },
    },
    application: {
      id: 'stitchwire-agent',
      lifecycle: 'running',
      health: 'healthy',
      ready: true,
      capturedAt: new Date().toISOString(),
      resources: { total: 4, ready: 4, degraded: 0, failed: 0 },
    },
  };
}

/** The first lane report that satisfies `want`, kept as it was seen: the state moves on after. */
async function settle(agent: Agent, want: (lane: LaneReport) => boolean): Promise<LaneReport> {
  const seen: { lane?: LaneReport } = {};
  await until(async () => {
    const [lane] = (await agent.status()).lanes;
    if (lane !== undefined && want(lane)) seen.lane = lane;
    return seen.lane !== undefined;
  });
  if (seen.lane === undefined) throw new Error('lane state did not converge');
  return seen.lane;
}

test('a lane that cannot be dialled reports the transport reason, not just "down"', async () => {
  // Waiting for `connected === false` would return on the first poll, before a single dial has
  // been attempted — the lane starts disconnected. The arrival of the reason is the event.
  const lane = await settle(blocked, (l) => l.lastFailure !== null);
  expect(lane.connected).toBe(false);
  const failure = lane.lastFailure;
  expect(failure).not.toBeNull();
  if (failure === null) throw new Error('lane failure was not recorded');
  // The exact text belongs to the transport and will differ between engines; what is pinned is
  // that SOMETHING was said and that it is stamped, because an unstamped reason cannot be told
  // from a stale one on a lane that has been down for hours.
  expect(failure.reason.length).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(failure.at))).toBe(false);
  // A dial that fails because nothing is listening is not a refusal: nobody looked at the
  // handshake. `refused` is reserved for a broker that did look and said no, and marking this one
  // that is merely still starting.
  expect(failure.refused).toBe(false);
});

test('an admitted lane carries no failure', async () => {
  const lane = await settle(admitted, (l) => l.connected);
  expect(lane.connected).toBe(true);
  expect(lane.lastFailure).toBeNull();
});

test('the doctor prints the reason instead of a bare "down"', () => {
  const down = laneStatus({
    config: {
      ...NodeConfigSchema.parse({
        nodeId: 'probe',
        brokers: [{ id: 'dev', url: 'https://wire.invalid', token: TOKEN }],
      }),
      id: 'dev',
      url: 'https://wire.invalid',
      serves: false,
    },
    origin: undefined,
    connected: false,
    lastCheck: null,
    notConnectedSince: null,
    lastFailure: { at: '2026-09-01T02:37:00.000Z', reason: 'xhr poll error', refused: false },
    eventConsumers: [],
    pendingPublishes: 0,
    nodes: [],
    presenceReady: false,
    presencePending: false,
  });
  const lane = nodeChecks(observed(down), '/config/node.json').find((check) => check.code === 'lane');
  expect(lane?.detail).toContain('xhr poll error');
  expect(lane?.detail).toContain('2026-09-01T02:37:00.000Z');
});

test('a refusal says so, and says the lane is still asking', () => {
  const refused = laneStatus({
    config: {
      ...NodeConfigSchema.parse({
        nodeId: 'probe',
        brokers: [{ id: 'dev', url: 'https://wire.invalid', token: TOKEN }],
      }),
      id: 'dev',
      url: 'https://wire.invalid',
      serves: false,
    },
    origin: undefined,
    connected: false,
    lastCheck: null,
    notConnectedSince: null,
    lastFailure: { at: '2026-09-01T02:37:00.000Z', reason: 'release mismatch', refused: true },
    eventConsumers: [],
    pendingPublishes: 0,
    nodes: [],
    presenceReady: false,
    presencePending: false,
  });
  const lane = nodeChecks(observed(refused), '/config/node.json').find((check) => check.code === 'lane');
  expect(lane?.detail).toContain('refused by the broker, retrying');
});

test('silence is reported as silence, not left as a bare "down"', () => {
  // The case this exists for: a firewall that DROPS packets — a fail2ban ban — produces no
  // transport error at all, so `lastFailure` stays null and the lane reports `down` with nothing
  // else. Measured 2026-09-02 against a black-hole address: six seconds, not one event.
  const base = {
    config: {
      ...NodeConfigSchema.parse({
        nodeId: 'probe',
        brokers: [{ id: 'dev', url: 'https://wire.invalid', token: TOKEN }],
      }),
      id: 'dev',
      url: 'https://wire.invalid',
      serves: false,
    },
    origin: undefined,
    connected: false,
    lastCheck: null,
    lastFailure: null,
    eventConsumers: [],
    pendingPublishes: 0,
    nodes: [] as never[],
    presenceReady: false,
    presencePending: false,
  };

  const silent = laneStatus({ ...base, notConnectedSince: new Date(Date.now() - 30_000).toISOString() });
  const [lane] = silent.lanes;
  expect(lane?.lastFailure).not.toBeNull();
  expect(lane?.lastFailure?.reason).toContain('no answer from the broker');
  expect(lane?.lastFailure?.reason).toContain('30s');
  expect(lane?.lastFailure?.refused).toBe(false);

  // A broker restarting is back well inside the window, so an ordinary rollout stays quiet.
  const restarting = laneStatus({ ...base, notConnectedSince: new Date(Date.now() - 500).toISOString() });
  expect(restarting.lanes[0]?.lastFailure).toBeNull();

  // And a real transport error always wins: silence is the fallback, never an override.
  const refused = laneStatus({
    ...base,
    notConnectedSince: new Date(Date.now() - 30_000).toISOString(),
    lastFailure: { at: '2026-09-02T01:00:00.000Z', reason: 'websocket error', refused: false },
  });
  expect(refused.lanes[0]?.lastFailure?.reason).toBe('websocket error');
});
