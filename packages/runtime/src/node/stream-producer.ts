import { ownEntry } from '../json.ts';
import { policyRefusal } from '../../../contracts/src/protocol/failure.ts';
import type { StreamCancel, StreamInvoke } from '../../../contracts/src/protocol/stream.ts';
import type { NodeConfig } from '../config/node.ts';
import type { ServiceExecutor } from '../service/executor.ts';
import type { ExecutionAdmission } from './admission.ts';
import { ProducerSession, type ProducerTransport } from './stream-producer-session.ts';

export class StreamProducerManager {
  private readonly sessions = new Map<string, ProducerSession>();
  private closed = false;

  constructor(
    private readonly config: NodeConfig,
    private readonly transport: ProducerTransport,
    /** One per agent, from `streamExecutionAdmission`: the agent knows whether drop-in services exist. */
    private readonly admission: ExecutionAdmission,
    private readonly services?: Pick<ServiceExecutor, 'openStream'>,
  ) {}

  start(invoke: StreamInvoke): void {
    if (this.closed || this.sessions.has(invoke.open.streamId)) return;
    const source = invoke.open.source;
    const profile = source.kind === 'profile' ? ownEntry(this.config.streams, source.profile) : null;
    if (source.kind === 'profile' && profile === undefined) {
      void this.transport.error({
        streamId: invoke.open.streamId,
        from: invoke.open.to,
        ...policyRefusal(`'${source.profile}' is not an allowlisted stream profile`),
        reason: 'error',
      });
      return;
    }
    if (source.kind === 'service' && this.services === undefined) {
      void this.transport.error({
        streamId: invoke.open.streamId,
        from: invoke.open.to,
        ...policyRefusal('service stream execution is not configured'),
        reason: 'error',
      });
      return;
    }
    const admissionKey = source.kind === 'profile' ? source.profile : `service:${source.service}`;
    const lease = this.admission.acquire(admissionKey);
    if (!lease.accepted) {
      void this.transport.error({
        streamId: invoke.open.streamId,
        from: invoke.open.to,
        ...lease.refused,
        reason: 'limit',
      });
      return;
    }
    const session = new ProducerSession(
      invoke,
      profile ?? null,
      this.services,
      this.transport,
      lease.release,
      () => {
        if (this.sessions.get(invoke.open.streamId) === session) this.sessions.delete(invoke.open.streamId);
      },
    );
    this.sessions.set(invoke.open.streamId, session);
    void session.run();
  }

  addCredit(streamId: string, bytes: number): void {
    this.sessions.get(streamId)?.addCredit(bytes);
  }

  cancel(cancel: StreamCancel): void {
    void this.sessions.get(cancel.streamId)?.cancel('cancelled', false);
  }

  async stop(final = false): Promise<void> {
    if (final) {
      this.closed = true;
      this.admission.stopAdmission();
    }
    const stopped = [...this.sessions.entries()];
    await Promise.all(stopped.map(([, session]) => session.cancel('cancelled', false)));
    for (const [id, session] of stopped) if (this.sessions.get(id) === session) this.sessions.delete(id);
  }
}
