import { describe, expect, test } from 'bun:test';
import * as browserContracts from '../packages/client/src/contracts.ts';

describe('forward-compatible additive field stripping across exported sub-schemas', () => {
  test('AuditStatusSchema, LaneStatusSchema, FleetNodeStatusSchema, FleetEditionStatusSchema and PeerResultSchema strip unknown fields', () => {
    const audit = browserContracts.AuditStatusSchema.parse({
      queued: 0,
      dropped: 0,
      writeFailures: 0,
      lastFailure: null,
      futureAuditField: 'x',
      journal: {
        path: '/tmp/a.jsonl',
        bytes: 1,
        generations: 0,
        maxBytes: 1024,
        keep: 2,
        rotations: 0,
        futureJournalField: 2,
      },
    });
    expect('futureAuditField' in audit).toBe(false);
    expect('futureJournalField' in audit.journal).toBe(false);

    const lane = browserContracts.LaneStatusSchema.parse({
      id: 'primary',
      url: 'wss://broker.example.test',
      connected: true,
      eventSubscriptions: {
        observedAt: '2026-11-23T00:00:00.000Z',
        activeSubscriptions: 1,
        futureSubField: true,
      },
      serves: true,
      nodesVisible: 2,
      presence: 'ready',
      lastFailure: { at: '2026-11-23T00:00:00.000Z', reason: 'timeout', refused: false, futureFail: 1 },
      futureLaneField: 3,
    });
    expect('futureLaneField' in lane).toBe(false);
    expect('futureSubField' in lane.eventSubscriptions).toBe(false);

    const edition = browserContracts.FleetEditionStatusSchema.parse({
      serial: 1,
      issuedAt: '2026-11-23T00:00:00.000Z',
      signer: 'k1',
      config: 'aligned',
      detail: null,
      checkedAt: '2026-11-23T00:00:00.000Z',
      futureEditionField: true,
    });
    expect('futureEditionField' in edition).toBe(false);

    const nodeBundle = browserContracts.FleetNodeStatusSchema.parse({
      ...edition,
      copy: 'own',
      lanes: [{ lane: 'primary', serial: 1, syncedAt: '2026-11-23T00:00:00.000Z', detail: null, extra: 1 }],
      futureNodeField: 2,
    });
    expect('futureNodeField' in nodeBundle).toBe(false);

    const peer = browserContracts.PeerResultSchema.parse({
      v: browserContracts.LOCAL_API_VERSION,
      observer: 'hub',
      target: 'worker',
      route: {
        id: 'primary',
        url: 'wss://broker.example.test',
        epoch: 'epoch-1',
        futureRouteField: true,
      },
      outcome: 'ok',
      observedAt: '2026-11-23T00:00:00.000Z',
      freshnessMs: 5000,
      ageMs: 120,
      aggregationWindowMs: 60000,
      sampleCount: 3,
      latestMs: 12,
      medianMs: 11,
      futurePeerField: 1,
    });
    expect('futurePeerField' in peer).toBe(false);
    expect(peer.route && 'futureRouteField' in peer.route).toBe(false);
  });
});
