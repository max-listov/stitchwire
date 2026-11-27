/** One opening deadline from entry, followed by an independent admitted stream lifetime. */
export class ServiceDispatchBudget {
  readonly controller = new AbortController();
  private readonly startedAt = performance.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expired = false;
  private readonly abort = () => {
    clearTimeout(this.timer);
    if (!this.controller.signal.aborted) this.controller.abort(this.caller.reason);
  };

  constructor(
    private readonly caller: AbortSignal,
    timeoutMs: number,
  ) {
    caller.addEventListener('abort', this.abort, { once: true });
    if (caller.aborted) this.abort();
    this.opening(timeoutMs);
  }

  get timedOut(): boolean {
    return this.expired;
  }

  opening(timeoutMs: number): void {
    this.arm(timeoutMs - (performance.now() - this.startedAt));
  }

  lifetime(timeoutMs: number): void {
    this.arm(timeoutMs);
  }

  private arm(remainingMs: number): void {
    clearTimeout(this.timer);
    if (this.controller.signal.aborted) return;
    const expire = () => {
      if (this.controller.signal.aborted) return;
      this.expired = true;
      this.controller.abort('executor-deadline');
    };
    if (remainingMs <= 0) expire();
    else this.timer = setTimeout(expire, remainingMs);
  }

  /** Stop waiting for read-only preflight without allowing its late result to dispatch. */
  async wait<T>(work: Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    const cancellation = Promise.withResolvers<never>();
    const abort = () => cancellation.reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      return await Promise.race([work, cancellation.promise]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.caller.removeEventListener('abort', this.abort);
    this.controller.abort();
  }
}
