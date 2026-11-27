import { afterAll, afterEach, beforeEach, expect, type Mock, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FleetPublishAck, FleetSyncAck } from '../packages/contracts/src/fleet/bundle.ts';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { buildBundle } from '../packages/runtime/src/fleet/bundle.ts';
import { fleetSigner } from './signed-fleet.ts';
import { FleetFollower, type FleetLane } from '../packages/runtime/src/node/fleet-follower.ts';
import { UnansweredQuestions } from '../packages/runtime/src/node/unanswered.ts';
import { until } from './support.ts';

/**
 * A broker that left `fleet:sync` or `fleet:publish` unanswered is asked again; the node does not keep
 * `not answered` until the lane next reconnects. A refusal is an answer and is not asked again.
 *
 * The retry spacing is six POLLS, so the clock these tests move is `Date.now`, which is what the node
 * reads it from, and the follower's own timer only supplies the polls. Nothing here asserts how long
 * anything took (ADR 0012).
 */

const root = mkdtempSync(join(tmpdir(), 'wire-fleet-retry-'));
/** The follower's poll interval; the spacing below is counted in these, never waited out. */
const POLL_MS = 20;
const RETRY_POLLS = 6;
const key = fleetSigner('signer');
const followers: FleetFollower[] = [];
let clock = 1_000_000;
let now: Mock<typeof Date.now>;

beforeEach(() => {
  clock = 1_000_000;
  now = spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(() => {
  now.mockRestore();
});
afterAll(() => {
  for (const follower of followers) follower.stop();
  rmSync(root, { recursive: true, force: true });
});

/** Moves the clock a node reads by `polls` poll intervals. */
const advance = (polls: number): void => {
  clock += polls * POLL_MS;
};

/** Waits until the follower has polled `count` more times; each poll stamps a new `checkedAt`. */
async function polled(follower: FleetFollower, count: number): Promise<void> {
  const seen = new Set<string>();
  const reached = await until(
    () => {
      const at = follower.snapshot().checkedAt;
      if (at !== null) seen.add(at);
      return seen.size > count;
    },
    undefined,
    2,
  );
  expect(reached).toBe(true);
}

interface Script {
  /** The nth question of the lane (counted from 1); `null` leaves it unanswered. */
  sync?: (call: number) => FleetSyncAck | null;
  publish?: (call: number) => FleetPublishAck | null;
  /** Holds every answer until the test releases it, so a question stays open. */
  gate?: Promise<void>;
}

function follow(script: Script, held?: { edition: Parameters<typeof buildBundle>[0]['manifest'] }) {
  const syncs: number[] = [];
  const publications: number[] = [];
  let inflight = 0;
  let overlapped = false;
  const open = async <T>(answer: () => T): Promise<T> => {
    if (++inflight > 1) overlapped = true;
    await script.gate;
    inflight--;
    return answer();
  };
  const lane: FleetLane = {
    connected: true,
    syncFleet: () => {
      syncs.push(clock);
      return open(() =>
        script.sync === undefined ? { serial: null, bundle: null } : script.sync(syncs.length),
      );
    },
    publishFleet: () => {
      publications.push(clock);
      return open(() => script.publish?.(publications.length) ?? null);
    },
  };
  const copy = join(root, `copy-${followers.length}.json`);
  if (held !== undefined)
    writeFileSync(copy, JSON.stringify(key.edition(held.edition, 5, '2026-10-20T00:00:00.000Z')));
  const running = NodeConfigSchema.parse({
    nodeId: 'reader',
    brokers: [{ id: 'primary', url: 'http://127.0.0.1:1', token: 't'.repeat(40) }],
    fleet: { trust: key.trust, copy },
  });
  // A node's poll is at least 200 ms; the follower only counts polls, so a short one is read the same.
  const fleet = running.fleet === undefined ? undefined : { ...running.fleet, pollMs: POLL_MS };
  const follower = new FleetFollower('reader', fleet, running, undefined, undefined);
  followers.push(follower);
  follower.attach('primary', lane);
  follower.start();
  follower.laneChanged('primary');
  return { follower, syncs, publications, overlapped: () => overlapped };
}

const fullManifest = FleetManifestSchema.parse({
  version: 1,
  members: { reader: { copy: 'full' } },
  access: [],
});
const detail = (follower: FleetFollower) => follower.snapshot().lanes[0]?.detail;

test('a question left unanswered is due again after six polls, and never beside an open one', async () => {
  const questions = new UnansweredQuestions();
  expect(await questions.track('primary', async () => null)).toMatchObject({ answer: null });
  expect(questions.due(POLL_MS)).toEqual([]);
  advance(RETRY_POLLS - 1);
  expect(questions.due(POLL_MS)).toEqual([]);
  advance(1);
  expect(questions.due(POLL_MS)).toEqual(['primary']);

  // A question that is open is never asked beside, however long the earlier one has been lost.
  const answer = Promise.withResolvers<null>();
  const open = questions.track('primary', () => answer.promise);
  advance(10 * RETRY_POLLS);
  expect(questions.due(POLL_MS)).toEqual([]);
  answer.resolve(null);
  await open;
  // Left unanswered again, it waits its own six polls from now.
  expect(questions.due(POLL_MS)).toEqual([]);
  advance(RETRY_POLLS);
  expect(questions.due(POLL_MS)).toEqual(['primary']);

  expect(await questions.track('primary', async () => ({ serial: 1 }))).toMatchObject({ current: true });
  advance(10 * RETRY_POLLS);
  expect(questions.due(POLL_MS)).toEqual([]);
});

test('an unanswered sync is asked again on a later poll and the answer clears the status', async () => {
  const { follower, syncs } = follow({ sync: (call) => (call < 3 ? null : { serial: null, bundle: null }) });
  expect(await until(() => detail(follower) === 'not answered')).toBe(true);
  // The clock has not moved, so however many polls pass the broker is not asked again.
  await polled(follower, 2 * RETRY_POLLS);
  expect(syncs).toHaveLength(1);
  advance(RETRY_POLLS);
  expect(await until(() => syncs.length === 2)).toBe(true);
  expect(detail(follower)).toBe('not answered');
  advance(RETRY_POLLS);
  expect(await until(() => detail(follower) === null)).toBe(true);
  expect(syncs).toHaveLength(3);
  // Answered, it is not asked again.
  advance(10 * RETRY_POLLS);
  await polled(follower, 2 * RETRY_POLLS);
  expect(syncs).toHaveLength(3);
});

test('a question in flight is never joined by a second one, from a reconnect or a retry', async () => {
  const gate = Promise.withResolvers<void>();
  const { follower, syncs, overlapped } = follow({ sync: () => null, gate: gate.promise });
  expect(await until(() => syncs.length === 1)).toBe(true);
  // Every reconnect and every poll below lands while the first question is open.
  for (let reconnect = 0; reconnect < 3; reconnect++) follower.laneChanged('primary');
  advance(10 * RETRY_POLLS);
  await polled(follower, 2 * RETRY_POLLS);
  expect(syncs).toHaveLength(1);
  gate.resolve();
  // The reconnects that came while it was open are asked once it is answered, as one question.
  expect(await until(() => syncs.length >= 2)).toBe(true);
  expect(overlapped()).toBe(false);
});

test('an offer that arrives while a sync is open is asked once the sync is answered', async () => {
  // The first sync is answered, so nothing would ever retry it: only the offer can cause a second one.
  const gate = Promise.withResolvers<void>();
  const { follower, syncs, overlapped } = follow({ gate: gate.promise });
  expect(await until(() => syncs.length === 1)).toBe(true);
  follower.offered('primary', 7);
  await polled(follower, 2);
  expect(syncs).toHaveLength(1);
  gate.resolve();
  expect(await until(() => syncs.length === 2)).toBe(true);
  expect(overlapped()).toBe(false);
  advance(10 * RETRY_POLLS);
  await polled(follower, 2 * RETRY_POLLS);
  expect(syncs).toHaveLength(2);
});

test('an unanswered publication is handed over again on a later poll, through a sync', async () => {
  const accepted: FleetPublishAck = { accepted: true, serial: 5, detail: 'kept' };
  const { follower, syncs, publications } = follow(
    { publish: (call) => (call === 1 ? null : accepted) },
    { edition: fullManifest },
  );
  expect(await until(() => detail(follower) === 'publication not answered')).toBe(true);
  // The broker keeps no edition, so every sync says it is behind and is followed by a publication.
  await polled(follower, 2 * RETRY_POLLS);
  expect(publications).toHaveLength(1);
  advance(RETRY_POLLS);
  expect(await until(() => publications.length === 2)).toBe(true);
  expect(await until(() => detail(follower) === null)).toBe(true);
  expect(follower.snapshot().lanes[0]?.serial).toBe(5);
  expect(syncs).toHaveLength(2);
});

test('a refused publication is an answer: it is reported once and not handed over again', async () => {
  const refusal: FleetPublishAck = {
    accepted: false,
    serial: null,
    detail: 'signed by a key this broker does not trust',
  };
  const { follower, syncs, publications } = follow({ publish: () => refusal }, { edition: fullManifest });
  expect(await until(() => detail(follower) === refusal.detail)).toBe(true);
  advance(20 * RETRY_POLLS);
  await polled(follower, 2 * RETRY_POLLS);
  expect(publications).toHaveLength(1);
  expect(syncs).toHaveLength(1);
  expect(detail(follower)).toBe(refusal.detail);
});
