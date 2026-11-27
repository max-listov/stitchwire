/** One monotonic budget shared by routing and physical dispatch. */
export class RequestDeadline {
  private readonly expiresAt: number;

  constructor(timeoutMs: number, now = performance.now()) {
    this.expiresAt = now + timeoutMs;
  }

  remaining(now = performance.now()): number {
    return Math.max(0, Math.floor(this.expiresAt - now));
  }
}
