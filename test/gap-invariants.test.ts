import { describe, expect, test } from 'bun:test';
import { EventGapReasonSchema, EventGapSchema, eventGap } from '../packages/contracts/src/protocol/event.ts';
import { LocalEventGapSchema } from '../packages/contracts/src/door/results.ts';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';

const BOOT = '00000000-0000-4000-8000-000000000001';
const NEXT = '00000000-0000-4000-8000-000000000002';
const base = {
  subscriptionId: crypto.randomUUID(),
  topic: 'generic.events',
  producer: 'publisher',
  bootId: BOOT,
  fromSeq: 2,
  toSeq: 5,
  reason: 'overflow' as const,
};

/**
 * The door used to declare its own copy of these fields — same eight names, its own re-typed reason
 * enum, and NEITHER refinement. The wire path was saved by a parse before send; the node path,
 * which builds gaps of its own, was not. So an inverted range or a boot change with no successor
 * could reach a consumer unchecked. These tests exist to keep the two views one view.
 */
describe('a gap carries the same two invariants at the wire and at the door', () => {
  test('both views accept a well-formed gap', () => {
    expect(EventGapSchema.safeParse(base).success).toBe(true);
    expect(LocalEventGapSchema.safeParse({ v: LOCAL_API_VERSION, ...base }).success).toBe(true);
  });

  test('both views reject an inverted range', () => {
    const inverted = { ...base, fromSeq: 5, toSeq: 2 };
    expect(EventGapSchema.safeParse(inverted).success).toBe(false);
    expect(LocalEventGapSchema.safeParse({ v: LOCAL_API_VERSION, ...inverted }).success).toBe(false);
  });

  test('both views reject a boot change that does not name its successor', () => {
    const orphan = { ...base, reason: 'boot-change' as const };
    expect(EventGapSchema.safeParse(orphan).success).toBe(false);
    expect(LocalEventGapSchema.safeParse({ v: LOCAL_API_VERSION, ...orphan }).success).toBe(false);
  });

  test('both views reject a successor on a reason that is not a boot change', () => {
    const stray = { ...base, nextBootId: NEXT };
    expect(EventGapSchema.safeParse(stray).success).toBe(false);
    expect(LocalEventGapSchema.safeParse({ v: LOCAL_API_VERSION, ...stray }).success).toBe(false);
  });

  test('both views know the same five reasons', () => {
    for (const reason of EventGapReasonSchema.options) {
      const candidate = {
        ...base,
        reason,
        ...(reason === 'boot-change' ? { nextBootId: NEXT } : {}),
      };
      expect(EventGapSchema.safeParse(candidate).success).toBe(true);
      expect(LocalEventGapSchema.safeParse({ v: LOCAL_API_VERSION, ...candidate }).success).toBe(true);
    }
  });

  test('the factory refuses what the schema refuses, at construction', () => {
    expect(() => eventGap({ ...base, fromSeq: 9, toSeq: 1 })).toThrow();
    expect(() => eventGap({ ...base, reason: 'boot-change' })).toThrow();
    expect(eventGap(base).reason).toBe('overflow');
  });
});
