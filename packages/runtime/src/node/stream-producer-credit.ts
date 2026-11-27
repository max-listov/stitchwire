import type { StreamInvoke, StreamTerminalReason } from '../../../contracts/src/protocol/stream.ts';
import { ProducerFailure } from './stream-failure.ts';

/** Permission arrives from remote grants; local completion never replenishes it. */
export class RemoteStreamCredit {
  private available = 0;
  private wake: (() => void) | undefined;
  private cancelled: StreamTerminalReason | undefined;

  constructor(private readonly limits: StreamInvoke['limits']) {}

  grant(bytes: number): boolean {
    if (this.cancelled !== undefined) return false;
    if (this.available + bytes > this.limits.maxWindowBytes) return false;
    this.available += bytes;
    this.notify();
    return true;
  }

  consume(bytes: number): void {
    this.available -= bytes;
  }

  cancel(reason: StreamTerminalReason): void {
    this.cancelled ??= reason;
    this.notify();
  }

  async wait(bytes: number): Promise<void> {
    const started = performance.now();
    while (this.cancelled === undefined && this.available < bytes) {
      const remaining = this.limits.slowConsumerTimeoutMs - (performance.now() - started);
      if (remaining <= 0) throw new ProducerFailure('slow-consumer', 'consumer credit timed out');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => this.notify(), remaining);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    if (this.cancelled !== undefined) throw new ProducerFailure(this.cancelled, 'stream was cancelled');
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }
}
