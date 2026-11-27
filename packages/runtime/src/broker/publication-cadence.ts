/** Sixty bounded minute buckets; rejected attempts never enter the observation. */
export class PublicationCadence {
  private readonly buckets = new Map<number, { count: number; first: number; last: number }>();
  record(now: number): void {
    const minute = Math.floor(now / 60_000);
    const held = this.buckets.get(minute);
    this.buckets.set(minute, { count: (held?.count ?? 0) + 1, first: held?.first ?? now, last: now });
    for (const key of this.buckets.keys()) if (key <= minute - 60) this.buckets.delete(key);
  }
  read(now: number): { count: number; windowMs: number } {
    const oldest = Math.floor(now / 60_000) - 59;
    let count = 0,
      first = now,
      last = 0;
    for (const [minute, bucket] of this.buckets)
      if (minute >= oldest && minute <= Math.floor(now / 60_000)) {
        count += bucket.count;
        first = Math.min(first, bucket.first);
        last = Math.max(last, bucket.last);
      }
    // Silence must not stretch its own threshold. Measure publication intervals, not idle time.
    return { count, windowMs: Math.max(0, last - first) };
  }
}
