import { expect, test } from 'bun:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { z } from 'zod';
import { LocalStatusSchema } from '../packages/contracts/src/door/status.ts';
import { LocalEventSubscriptionStateSchema } from '../packages/contracts/src/door/event-lifecycle.ts';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';
import type { ServiceDiagnosticsSchema } from '../packages/contracts/src/service/diagnostics.ts';
import {
  readEventItem,
  PeerResultSchema,
  readResponse,
  ServiceResultReaderSchema,
  StatusResultSchema,
} from '../packages/local-client/src/readers.ts';
import { PEER_FRESH_MS, PEER_WINDOW_MS } from '../packages/contracts/src/peer-contract.ts';
import { createWireClient } from '../packages/client/src/index.ts';
import { withDoor } from './client-fixture.ts';
import { status as fixture } from './doctor-fixture.ts';

/**
 * The SDK reads the door it was built for and ignores fields a later runtime adds to any object:
 * a runtime that grows a field must not turn a finished call into `invalid-response`.
 */

/** A copy of `value` with one unknown field on every object, at every depth. */
function withExtraFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withExtraFields);
  if (value === null || typeof value !== 'object') return value;
  const copy: Record<string, unknown> = { additiveField: 'later runtime' };
  for (const [key, member] of Object.entries(value)) copy[key] = withExtraFields(member);
  return copy;
}

const now = new Date().toISOString();
const anomaly = {
  file: 'a',
  offset: 0,
  line: 1,
  reason: 'invalid-json',
  position: 'tail',
  terminated: true,
  skippedBytes: 1,
} as const;
const audit = {
  queued: 1,
  dropped: 0,
  writeFailures: 0,
  lastFailure: null,
  recovery: {
    filesChecked: 1,
    anomalies: 2,
    skippedBytes: 3,
    firstAnomaly: anomaly,
    lastAnomaly: anomaly,
    quarantined: [{ file: 'b', quarantinedAs: 'b.q', reason: 'unreadable', code: 'EIO' }],
    quarantinedUnlisted: 0,
  },
  journal: { path: '/j', bytes: 1, generations: 1, maxBytes: 4096, keep: 1, rotations: 0 },
};

/** A status that exercises every nested object the door reports. */
function populatedStatus() {
  const base = fixture();
  return LocalStatusSchema.parse({
    ...base,
    lanes: [
      {
        ...base.lanes[0],
        lastFailure: { at: now, reason: 'refused', refused: true },
      },
    ],
    allow: [
      {
        name: 'echo',
        path: '/bin/echo',
        present: true,
        cwd: null,
        cwdPresent: true,
        callerArgs: 'none',
        stdin: 'none',
        timeoutMs: 1000,
        outputBytes: 10,
        concurrency: 1,
      },
    ],
    streams: [
      {
        name: 'logs',
        path: '/bin/cat',
        present: true,
        cwd: null,
        cwdPresent: true,
        format: 'raw',
        stableCursor: false,
        timeoutMs: 1000,
        maxBytes: 10,
        concurrency: 1,
      },
    ],
    events: {
      ...base.events,
      declarations: {
        descriptors: [{ path: '/d.json', state: 'loaded', topics: 1, detail: null }],
        refused: [{ topic: 'a.b', detail: 'outside' }],
        lanes: [{ lane: 'primary', declaredAt: now, accepted: 1, refused: [{ topic: 'a.c', detail: 'no' }] }],
      },
      subscriptions: [{ subscriptionId: crypto.randomUUID(), topic: 'a.b' }],
      topics: [{ topic: 'a.b', activeSubscriptions: 1 }],
    },
    services: {
      namespaces: ['owner.'],
      declarations: {
        descriptors: [{ path: '/s.json', state: 'loaded', service: 'owner.x', callers: 1, detail: null }],
        refused: [{ path: '/t.json', service: 'other.x', detail: 'outside' }],
        lanes: [
          {
            lane: 'primary',
            declaredAt: now,
            accepted: 1,
            refused: [{ service: 'owner.x', caller: 'reader', detail: 'no' }],
          },
        ],
      },
    },
    bundle: {
      ...base.bundle,
      lanes: [{ lane: 'primary', serial: 1, syncedAt: now, detail: null }],
    },
    publicationAudit: audit,
    serviceAudit: audit,
    nodes: [
      {
        nodeId: 'worker',
        online: true,
        serves: true,
        connections: 1,
        since: now,
        version: '1.0.0',
        behind: null,
        departure: null,
        versionSeenAt: now,
        observingSince: now,
      },
    ],
  });
}

test('every object of a status may carry fields this SDK does not know', () => {
  const populated = populatedStatus();
  const read = readResponse(StatusResultSchema, withExtraFields(populated));
  expect(read).toEqual(populated);
});

test('a subscription state and the diagnostics of a service outcome may carry fields this SDK does not know', () => {
  const state = LocalEventSubscriptionStateSchema.parse({
    v: LOCAL_API_VERSION,
    subscriptionId: crypto.randomUUID(),
    topic: 'a.b',
    subscriptionState: 'ready',
    lanes: ['primary'],
  });
  const item = readEventItem(withExtraFields(state));
  expect(item).toEqual({ kind: 'subscription', frame: state });

  const diagnostics: z.output<typeof ServiceDiagnosticsSchema> = {
    traceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    phases: [{ phase: 'terminal', elapsedMs: 3 }],
  };
  const result: z.output<typeof ServiceResultReaderSchema> = {
    v: LOCAL_API_VERSION,
    traceId: diagnostics.traceId,
    outcome: { status: 'response', delivery: 'received', httpStatus: 200, payload: '{}', diagnostics },
  };
  const read = ServiceResultReaderSchema.parse(withExtraFields(result));
  expect(read).toEqual(result);
});

test('the failure of a service outcome and a peer observation may carry fields this SDK does not know', () => {
  const failure: z.output<typeof ServiceResultReaderSchema> = {
    v: LOCAL_API_VERSION,
    traceId: crypto.randomUUID(),
    outcome: {
      status: 'failure',
      code: 'offline',
      delivery: 'not-dispatched',
      retryAfterMs: null,
      refusal: 'none',
      transportCause: 'target-offline',
    },
  };
  expect(ServiceResultReaderSchema.parse(withExtraFields(failure))).toEqual(failure);

  const observation: z.output<typeof PeerResultSchema> = {
    v: LOCAL_API_VERSION,
    observer: 'reader',
    target: 'worker',
    route: { id: 'primary', url: 'http://127.0.0.1:1', epoch: 'e1' },
    outcome: 'ok',
    observedAt: now,
    freshnessMs: PEER_FRESH_MS,
    ageMs: 1,
    aggregationWindowMs: PEER_WINDOW_MS,
    sampleCount: 1,
    latestMs: 1,
    medianMs: 1,
  };
  expect(PeerResultSchema.parse(withExtraFields(observation))).toEqual(observation);
});

/**
 * The same objects through the client's own methods, over a door that answers the way a later runtime
 * would. A runtime cannot send a field it does not have yet, so the door is the one stand-in: the
 * client's request, its parsing of the response and its return value are the real ones.
 */
const respondWith = (value: unknown) => (_request: IncomingMessage, response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
};

test('the client reads the status of a door that adds fields to every object', async () => {
  const populated = populatedStatus();
  // The control: the door's own schema refuses what the client is expected to accept.
  expect(LocalStatusSchema.safeParse(withExtraFields(populated)).success).toBe(false);
  await withDoor(respondWith(withExtraFields(populated)), async (socketPath) => {
    using client = createWireClient({ socketPath });
    expect(await client.status()).toEqual(populated);
  });
});

test('the client reads a subscription state and an event of a door that adds fields to them', async () => {
  const state = LocalEventSubscriptionStateSchema.parse({
    v: LOCAL_API_VERSION,
    subscriptionId: crypto.randomUUID(),
    topic: 'a.b',
    subscriptionState: 'ready',
    lanes: ['primary'],
  });
  await withDoor(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify(withExtraFields(state))}\n`);
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      const first = await client.subscribe({ topic: 'a.b', lifecycle: true }).next();
      expect(first.done).toBe(false);
      expect(first.value).toEqual({ kind: 'subscription', frame: state });
    },
  );
});

test('the client returns the response and the failure of a service call whose door adds fields', async () => {
  const traceId = crypto.randomUUID();
  const call = {
    to: 'worker',
    service: 'owner.catalog',
    revision: '1',
    operation: 'lookup',
    payload: '{}',
    timeoutMs: 2_000,
  };
  const diagnostics = {
    traceId,
    requestId: crypto.randomUUID(),
    phases: [{ phase: 'terminal' as const, elapsedMs: 3 }],
  };
  const answered: z.output<typeof ServiceResultReaderSchema> = {
    v: LOCAL_API_VERSION,
    traceId,
    outcome: { status: 'response', delivery: 'received', httpStatus: 200, payload: '{}', diagnostics },
  };
  const failed: z.output<typeof ServiceResultReaderSchema> = {
    v: LOCAL_API_VERSION,
    traceId,
    outcome: {
      status: 'failure',
      code: 'offline',
      delivery: 'not-dispatched',
      retryAfterMs: null,
      refusal: 'none',
      transportCause: 'target-offline',
    },
  };
  for (const result of [answered, failed]) {
    await withDoor(respondWith(withExtraFields(result)), async (socketPath) => {
      using client = createWireClient({ socketPath });
      expect((await client.invokeService(call)).outcome).toEqual(result.outcome);
    });
  }
});
