import type { EventLoopDelaySnapshot } from './contracts.ts';

export const EVENT_LOOP_DELAY_WARN_MS = 250;

/**
 * How far back `maxMs` looks.
 *
 * A window, not the broker's lifetime. A maximum over the lifetime keeps the broker's health yellow
 * for as long as the process lives (measured 2026-09-14: `maxMs=257.9` beside `lastMs=1.3`, a day
 * after the stall, on every check) — a warning nobody can clear except by restarting, which teaches
 * the habit of ignoring it. A window answers the question an operator asks — "is it stalling now" —
 * and still keeps a stall visible for five minutes.
 */
export const EVENT_LOOP_DELAY_WINDOW_MS = 300_000;
const BUCKET_MS = 10_000;

/** A live event-loop measurement. It reports observed delay after the loop resumes, never CPU cause. */
export class EventLoopDelayMonitor {
  private current: EventLoopDelaySnapshot = {
    state: 'unknown',
    sampledAt: null,
    lastMs: null,
    maxMs: null,
    windowMs: EVENT_LOOP_DELAY_WINDOW_MS,
  };
  /** The worst delay per ten-second bucket, oldest first: thirty numbers, whatever the sample rate. */
  private readonly buckets: { start: number; maxMs: number }[] = [];

  constructor(private readonly onSample: (snapshot: EventLoopDelaySnapshot) => void = () => {}) {}

  snapshot(): EventLoopDelaySnapshot {
    return this.current;
  }

  /** Public so the measurement rule can be falsified without starving the test runner. */
  observe(expectedAt: number, observedAt: number, sampledAt: string): EventLoopDelaySnapshot {
    const lastMs = Math.max(0, observedAt - expectedAt);
    const start = observedAt - (observedAt % BUCKET_MS);
    const newest = this.buckets.at(-1);
    if (newest !== undefined && newest.start === start) newest.maxMs = Math.max(newest.maxMs, lastMs);
    else this.buckets.push({ start, maxMs: lastMs });
    while ((this.buckets[0]?.start ?? observedAt) <= observedAt - EVENT_LOOP_DELAY_WINDOW_MS)
      this.buckets.shift();
    let maxMs = 0;
    for (const bucket of this.buckets) maxMs = Math.max(maxMs, bucket.maxMs);
    this.current = { state: 'measured', sampledAt, lastMs, maxMs, windowMs: EVENT_LOOP_DELAY_WINDOW_MS };
    this.onSample(this.current);
    return this.current;
  }
}
