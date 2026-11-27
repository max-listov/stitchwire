import { z } from 'zod';
import { EVENT_LOOP_DELAY_WARN_MS } from './event-loop-delay.ts';

const STALL_AUDIT_WINDOW_MS = 10_000;
export const StallAuditSchema = z.strictObject({
  kind: z.literal('event-loop-delay'),
  broker: z.string(),
  delayMs: z.number().nonnegative(),
  count: z.number().int().positive(),
  windowMs: z.literal(STALL_AUDIT_WINDOW_MS),
  firstObservedAt: z.iso.datetime(),
  lastObservedAt: z.iso.datetime(),
});
export type StallAudit = z.infer<typeof StallAuditSchema>;

/** O(1) aggregation of measured callback delays; a sample is not a diagnosed host incident. */
export class StallAuditWindow {
  private pending: { start: number; count: number; maxMs: number; first: string; last: string } | undefined;
  constructor(
    private readonly broker: string,
    private readonly emit: (event: StallAudit) => void,
  ) {}
  observe(delayMs: number, now: number, sampledAt: string): void {
    if (this.pending && now - this.pending.start >= STALL_AUDIT_WINDOW_MS) this.flush();
    if (delayMs < EVENT_LOOP_DELAY_WARN_MS) return;
    if (!this.pending) this.pending = { start: now, count: 0, maxMs: 0, first: sampledAt, last: sampledAt };
    this.pending.count++;
    this.pending.maxMs = Math.max(this.pending.maxMs, delayMs);
    this.pending.last = sampledAt;
  }
  flush(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    this.emit({
      kind: 'event-loop-delay',
      broker: this.broker,
      delayMs: pending.maxMs,
      count: pending.count,
      windowMs: STALL_AUDIT_WINDOW_MS,
      firstObservedAt: pending.first,
      lastObservedAt: pending.last,
    });
  }
}
