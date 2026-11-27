import type { StreamInvoke } from '../../../contracts/src/protocol/stream.ts';
import type { ServiceDispatch, ServiceExecutor } from '../service/executor.ts';

/** Owns the service transport state for one stream source. */
export class ServiceStreamSource {
  private readonly abortController = new AbortController();
  private dispatch: Extract<ServiceDispatch, { accepted: true }> | null = null;

  constructor(
    private readonly invoke: StreamInvoke,
    private readonly services: Pick<ServiceExecutor, 'openStream'>,
  ) {}

  async open(): Promise<ServiceDispatch> {
    const source = this.invoke.open.source;
    if (source.kind !== 'service') throw new TypeError('service source requires a service invocation');
    const result = await this.services.openStream(
      {
        id: this.invoke.open.streamId,
        from: this.invoke.open.from,
        to: this.invoke.open.to,
        service: source.service,
        revision: source.revision,
        operation: source.operation,
        payload: source.payload,
        timeoutMs: this.invoke.open.timeoutMs,
      },
      this.abortController.signal,
    );
    if (result.accepted) this.dispatch = result;
    return result;
  }

  timedOut(): boolean {
    return this.dispatch?.timedOut() ?? false;
  }

  async cancel(): Promise<void> {
    this.abortController.abort();
    await this.close();
  }

  async close(): Promise<void> {
    await this.dispatch?.close();
  }
}
