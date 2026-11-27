/**
 * Absence with a manner attached.
 *
 * A fleet monitor called a node healthy for 1h47m while its agent was in a restart loop, because
 * its rule read `online: false` as "a laptop is asleep". The rule was wrong, but the reason it
 * could be written at all is that the broker offered a boolean and kept the manner of leaving to
 * itself — the transport's reason reached the audit journal and stopped there.
 *
 * So what is pinned here is not "a departure is recorded" but the four ways this field could
 * quietly lie: an unrecognised reason promoted to an explained absence, a broker's own restart
 * read as the node leaving, that same restart record burying the node's real departure because it
 * happens to be newer — the one that only appears with two brokers — and a null read as "it never
 * left" when it means "nothing was watching", which is what the horizon beside it exists to stop.
 */

import { expect, test } from 'bun:test';
import type { Departure, Presence } from '../packages/contracts/src/protocol/presence.ts';
import { BrokerHealthContractSchema } from '../packages/contracts/src/protocol/broker-health.ts';
import { classifyDeparture, Registry } from '../packages/runtime/src/broker/registry.ts';
import { brokerChecks } from '../packages/runtime/src/cli/doctor-broker.ts';
import { renderNodes } from '../packages/runtime/src/cli/render.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { mergePresence } from '../packages/runtime/src/node/presence.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';
import { status } from './doctor-fixture.ts';

test('the transport reasons this fleet actually produces classify into three meanings', () => {
  // Every value below was measured in the brokers' own journals, not imagined.
  expect(classifyDeparture('client namespace disconnect')).toBe('announced');
  expect(classifyDeparture('ping timeout')).toBe('lost');
  expect(classifyDeparture('transport close')).toBe('lost');
  expect(classifyDeparture('server shutting down')).toBe('broker-restart');
});

test('an unrecognised reason is lost, never announced', () => {
  // The direction matters: an absence nobody can explain must not read as an explained one, so a
  // future socket.io wording lands on the value that promises least.
  expect(classifyDeparture('some wording no version has used yet')).toBe('lost');
  expect(classifyDeparture('')).toBe('lost');
});

function presence(nodeId: string, departure: Departure | null, online = false): Presence {
  return {
    nodeId,
    online,
    serves: online,
    connections: online ? 1 : 0,
    since: online ? '2026-09-02T05:00:00.000Z' : null,
    version: '0.0.0',
    behind: null,
    versionSeenAt: null,
    departure,
    observingSince: '2026-09-02T00:00:00.000Z',
  };
}

test("a broker's own restart never buries the node's real departure, however much newer it is", () => {
  const lost: Departure = { at: '2026-09-02T03:03:00.000Z', reason: 'transport close', kind: 'lost' };
  const restart: Departure = {
    at: '2026-09-02T05:03:31.000Z',
    reason: 'server shutting down',
    kind: 'broker-restart',
  };
  // Two hours newer, and still the wrong answer: it is not about this node at all.
  expect(mergePresence(presence('laptop', lost), presence('laptop', restart)).departure).toEqual(lost);
  // And the same in the other order, so the result does not depend on which broker answered first.
  expect(mergePresence(presence('laptop', restart), presence('laptop', lost)).departure).toEqual(lost);
});

test('between two records that are both about the node, the clock decides', () => {
  const older: Departure = { at: '2026-09-02T01:40:53.855Z', reason: 'ping timeout', kind: 'lost' };
  const newer: Departure = {
    at: '2026-09-02T02:31:27.706Z',
    reason: 'client namespace disconnect',
    kind: 'announced',
  };
  expect(mergePresence(presence('laptop', older), presence('laptop', newer)).departure).toEqual(newer);
  expect(mergePresence(presence('laptop', newer), presence('laptop', older)).departure).toEqual(newer);
});

test('a node this broker has never seen leave carries no departure at all', () => {
  // Null is "nothing to say", and it must not be manufactured into a reassuring value.
  expect(mergePresence(presence('laptop', null), presence('laptop', null)).departure).toBeNull();
  const lost: Departure = { at: '2026-09-02T03:03:00.000Z', reason: 'ping timeout', kind: 'lost' };
  expect(mergePresence(presence('laptop', null), presence('laptop', lost)).departure).toEqual(lost);
});

test('the registry records a departure and the presence row carries it', () => {
  const config = BrokerConfigSchema.parse({
    nodes: [{ id: 'alpha', tokenSha256s: [sha256('t'.repeat(40))] }],
  });
  const registry = new Registry(config);

  // A registered node that has never left says nothing rather than something reassuring — and the
  // row carries the horizon that keeps that silence from being read as presence.
  expect(registry.presence()).toEqual([
    {
      nodeId: 'alpha',
      online: false,
      serves: false,
      connections: 0,
      since: null,
      version: null,
      departure: null,
      observingSince: registry.observingSince,
    },
  ]);

  registry.recordDeparture('alpha', 'ping timeout', '2026-09-02T03:03:00.000Z');
  expect(registry.presence()[0]?.departure).toEqual({
    at: '2026-09-02T03:03:00.000Z',
    reason: 'ping timeout',
    kind: 'lost',
  });

  // A later departure replaces the earlier one: this is the LAST departure, not a history.
  registry.recordDeparture('alpha', 'client namespace disconnect', '2026-09-02T04:00:00.000Z');
  expect(registry.presence()[0]?.departure?.kind).toBe('announced');
});

test('the broker states how far back a missing departure is worth anything', () => {
  // The horizon is not a verdict and must never become one: a freshly started broker is not
  // unhealthy, it is merely unable to answer about anything older than itself.
  const health = BrokerHealthContractSchema.parse({
    ok: true,
    nodes: [],
    observingSince: '2026-09-02T06:01:40.000Z',
    transport: {
      broker: '127.0.0.1:8790',
      lastDisconnect: null,
      eventLoopDelay: {
        state: 'measured',
        sampledAt: '2026-09-02T06:01:41.000Z',
        lastMs: 1,
        maxMs: 1,
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
    events: { accepted: 0, subscriptions: 0, topics: 0, recent: { count: 0, windowMs: 1000 } },
    topics: [],
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
  });
  const checks = brokerChecks(health);
  const horizon = checks.find((c) => c.code === 'departures.horizon');
  expect(checks.find((c) => c.code === 'broker.last-disconnect')?.level).toBe('ok');
  expect(horizon?.level).toBe('ok');
  expect(horizon?.detail).toContain('2026-09-02T06:01:40.000Z');
  // And it says what the absence is NOT, because that is the reading that caused the incident.
  expect(horizon?.detail).toContain('not proven present');
});

test('a broker forgets its own shutdown, which is why a snapshot cannot carry broker-restart', () => {
  // Not a nicety: a consumer wrote a branch against the opposite claim, taken from a comment of
  // mine that was reasoning rather than measurement. The registry is per-process, so the record of
  // "the broker went away" dies with the broker that wrote it.
  const config = BrokerConfigSchema.parse({
    nodes: [{ id: 'alpha', tokenSha256s: [sha256('t'.repeat(40))] }],
  });
  const before = new Registry(config);
  before.recordDeparture('alpha', 'server shutting down', '2026-09-02T06:37:12.000Z');
  expect(before.presence()[0]?.departure?.kind).toBe('broker-restart');

  // What a consumer reads after the restart is a NEW registry, and it knows nothing.
  const after = new Registry(config);
  expect(after.presence()[0]?.departure).toBeNull();
  // The only thing that survives is the horizon, which is what the question should be asked of.
  expect(after.observingSince >= before.observingSince).toBe(true);
});

test('merging two brokers keeps the horizon they BOTH vouch for, not the longer memory', () => {
  // The direction is the whole test. A broker watching since 08:00 with nothing recorded vouches
  // for that span; one that started at 10:00 vouches for nothing before it. Taking the earlier
  // horizon would spread one broker's silence over two hours the other cannot speak for, and that
  // silence would then be read as evidence the node stayed.
  const early = { ...presence('laptop', null), observingSince: '2026-09-02T08:00:00.000Z' };
  const late = { ...presence('laptop', null), observingSince: '2026-09-02T10:00:00.000Z' };
  expect(mergePresence(early, late).observingSince).toBe('2026-09-02T10:00:00.000Z');
  // Argument order is not allowed to decide it.
  expect(mergePresence(late, early).observingSince).toBe('2026-09-02T10:00:00.000Z');
  // The negative case: it is never the earlier one, which is the reassuring answer.
  expect(mergePresence(early, late).observingSince).not.toBe('2026-09-02T08:00:00.000Z');
});

test('the horizon survives a merge that carries a real departure from the other broker', () => {
  // The two fields are merged by different rules and must not borrow each other's winner: the
  // departure comes from whichever broker saw it, the horizon from whichever saw least.
  const lost: Departure = { at: '2026-09-02T09:00:00.000Z', reason: 'ping timeout', kind: 'lost' };
  const knowing = { ...presence('laptop', lost), observingSince: '2026-09-02T08:00:00.000Z' };
  const blank = { ...presence('laptop', null), observingSince: '2026-09-02T10:00:00.000Z' };
  const merged = mergePresence(knowing, blank);
  expect(merged.departure).toEqual(lost);
  expect(merged.observingSince).toBe('2026-09-02T10:00:00.000Z');
});

test('an offline node with no recorded departure prints why there is none', () => {
  // This row used to print the bare word "offline" and nothing else — every branch of the manner
  // of leaving fell through on a null. That word is what a fleet monitor read as a sleeping
  // laptop while the agent was in a restart loop.
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    renderNodes([{ ...presence('laptop', null), observingSince: '2026-09-02T06:01:40.000Z' }]);
  } finally {
    console.log = original;
  }
  const row = lines.find((line) => line.includes('laptop')) ?? '';
  expect(row).toContain('offline');
  expect(row).toContain('no departure recorded since 2026-09-02T06:01:40Z');
  expect(row).toContain('nothing was watching when it did');

  // The negative case: a row that DOES know how the node left says that instead, and never this.
  const knowing: string[] = [];
  console.log = (...args: unknown[]) => void knowing.push(args.join(' '));
  try {
    renderNodes([
      presence('laptop', { at: '2026-09-02T03:03:00.000Z', reason: 'ping timeout', kind: 'lost' }),
    ]);
  } finally {
    console.log = original;
  }
  expect(knowing.join('\n')).not.toContain('no departure recorded');
  expect(knowing.join('\n')).toContain('connection lost at 2026-09-02T03:03:00Z');
});

test('two horizons are compared as moments, in either order', () => {
  // One instant spelled with two offsets, and a horizon one hour later than it.
  const utc = {
    ...presence('laptop', null, true),
    since: '2026-09-02T05:00:00.000Z',
    observingSince: '2026-09-02T05:00:00.000Z',
  };
  const offset = {
    ...presence('laptop', null, true),
    since: '2026-09-02T11:00:00.000+07:00',
    observingSince: '2026-09-02T13:00:00.000+07:00',
  };
  for (const merged of [mergePresence(utc, offset), mergePresence(offset, utc)]) {
    // As text the offset spelling sorts later; as a moment it is one hour EARLIER, so it is the
    // earliest connection — and its horizon, one hour later, is the one both brokers vouch for.
    expect(Date.parse(merged.since ?? '')).toBe(Date.parse('2026-09-02T04:00:00.000Z'));
    expect(Date.parse(merged.observingSince)).toBe(Date.parse('2026-09-02T06:00:00.000Z'));
  }
  // Text that is no instant does not make the answer depend on which lane is listed first.
  const unreadable = { ...utc, observingSince: 'not a time' };
  expect(mergePresence(utc, unreadable).observingSince).toBe(mergePresence(unreadable, utc).observingSince);
});
