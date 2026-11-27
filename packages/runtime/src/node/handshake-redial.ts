type Schedule = (callback: () => void, delayMs: number) => () => void;

const scheduleTimer: Schedule = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** Socket.IO retries transport loss itself; refused handshakes need an explicit dial. */
export class HandshakeRedial {
  private delayMs: number;
  private cancel: (() => void) | undefined;
  private closed = false;

  constructor(
    private readonly minDelayMs: number,
    private readonly maxDelayMs: number,
    private readonly connect: () => void,
    private readonly schedule: Schedule = scheduleTimer,
  ) {
    this.delayMs = Math.min(minDelayMs, maxDelayMs);
  }

  refused(): void {
    if (this.closed || this.cancel) return;
    this.cancel = this.schedule(() => {
      this.cancel = undefined;
      if (this.closed) return;
      this.delayMs = Math.min(this.delayMs * 2, this.maxDelayMs);
      this.connect();
    }, this.delayMs);
  }

  connected(): void {
    this.cancel?.();
    this.cancel = undefined;
    this.delayMs = Math.min(this.minDelayMs, this.maxDelayMs);
  }

  stop(): void {
    this.closed = true;
    this.cancel?.();
    this.cancel = undefined;
  }
}
