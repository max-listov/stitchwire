import { NativeCommandError, type NativeCommandStream, streamNativeCommand } from 'stitchkit/process';
import { MAX_STDIN_BYTES } from '../../../contracts/src/protocol/bounds.ts';
import {
  type Refused,
  requestRefusal,
  unclassifiedFailure,
} from '../../../contracts/src/protocol/failure.ts';
import type {
  StreamAck,
  StreamChunk,
  StreamEnd,
  StreamError,
  StreamInvoke,
  StreamTerminalReason,
} from '../../../contracts/src/protocol/stream.ts';
import { wireLogger } from '../logger.ts';
import type { StreamProfile } from '../config/profiles.ts';
import type { ServiceExecutor } from '../service/executor.ts';
import { validateCallerArgs } from './caller-args.ts';
import { childEnv, exitStatus, ORDINARY_STOP_GRACE_MS, startFailure } from './exec.ts';
import { ServiceStreamSource } from './service-stream-source.ts';
import { ProducerFailure, producerRefusal, serviceOutcomeRefusal } from './stream-failure.ts';
import { RemoteStreamCredit } from './stream-producer-credit.ts';
import { ProducerSourceReader } from './stream-producer-source.ts';

export interface ProducerTransport {
  chunk(chunk: StreamChunk): Promise<StreamAck>;
  end(end: StreamEnd): Promise<StreamAck>;
  error(error: StreamError): Promise<StreamAck>;
}

function validateRequest(invoke: StreamInvoke, profile: StreamProfile): string | null {
  const source = invoke.open.source;
  if (source.kind !== 'profile') return null;
  const callerArgsProblem = validateCallerArgs(source.args, profile.callerArgs);
  if (callerArgsProblem !== null) return callerArgsProblem;
  if (profile.stdin.mode === 'none' && source.stdin !== null) return 'profile does not accept stdin';
  if (
    profile.stdin.mode === 'text' &&
    source.stdin !== null &&
    Buffer.byteLength(source.stdin) > profile.stdin.maxBytes
  ) {
    return 'stdin exceeds profile byte limit';
  }
  if (invoke.open.timeoutMs > profile.timeoutMs) return 'timeout exceeds profile limit';
  if (source.cursor !== null && (profile.format.mode !== 'ndjson' || !profile.format.stableCursor)) {
    return 'resume is unsupported by this producer profile';
  }
  return null;
}

export class ProducerSession {
  private readonly credit: RemoteStreamCredit;
  private readonly reader: ProducerSourceReader;
  private seq = 0;
  private totalBytes = 0;
  private lastCursor: string | null = null;
  private cancelled = false;
  private reportCancellation = false;
  private cancellationReason: StreamTerminalReason = 'cancelled';
  private command: NativeCommandStream | null = null;
  /** Ends the command's life with the session, whatever else has happened to it. */
  private readonly lifetime = new AbortController();
  private readonly serviceSource: ServiceStreamSource | null;
  private producerMaxBytes: number;
  /** stdout and stderr are read concurrently, but the wire is one ordered sequence. */
  private sendTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly invoke: StreamInvoke,
    private readonly profile: StreamProfile | null,
    services: Pick<ServiceExecutor, 'openStream'> | undefined,
    private readonly transport: ProducerTransport,
    private readonly release: () => void,
    private readonly onDone: () => void,
  ) {
    this.credit = new RemoteStreamCredit(invoke.limits);
    this.reader = new ProducerSourceReader(invoke, (channel, bytes, cursor) =>
      this.queueBytes(channel, bytes, cursor),
    );
    this.producerMaxBytes = profile?.maxBytes ?? invoke.limits.maxStreamBytes;
    this.serviceSource =
      invoke.open.source.kind === 'service' && services !== undefined
        ? new ServiceStreamSource(invoke, services)
        : null;
  }

  addCredit(bytes: number): void {
    if (this.cancelled) return;
    if (!this.credit.grant(bytes)) void this.cancel('limit', true);
  }

  async cancel(reason: StreamTerminalReason, report: boolean): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.reportCancellation = report;
    this.cancellationReason = reason;
    this.credit.cancel(reason);
    // A cleanup that fails is logged here: callers do not await a cancellation, so a rejection would
    // otherwise end the agent as an unhandled one.
    await this.command?.stop().catch((error: unknown) =>
      wireLogger.error('[wire] a stream producer command did not stop cleanly', {
        streamId: this.invoke.open.streamId,
        error: String(error),
      }),
    );
    await this.serviceSource?.cancel();
  }

  async run(): Promise<void> {
    if (this.invoke.open.source.kind === 'service') {
      await this.runService();
      return;
    }
    if (this.profile === null) throw new Error('profile stream has no profile policy');
    const problem = validateRequest(this.invoke, this.profile);
    if (problem !== null) {
      await this.sendError(
        problem.includes('unsupported') ? 'unsupported' : 'error',
        requestRefusal(problem),
      );
      this.finish();
      return;
    }

    const source = this.invoke.open.source;
    const env = childEnv(this.invoke.open.from, this.profile);
    if (source.cursor !== null) env.STITCHWIRE_STREAM_CURSOR = source.cursor;
    // The leader's own status, whichever way it ended; a command that never started has none, and 1 stands for it.
    const status = Promise.withResolvers<number>();
    try {
      this.command = streamNativeCommand({
        executable: this.profile.bin,
        args: [...this.profile.argv, ...source.args],
        cwd: this.profile.cwd,
        envPolicy: 'declared-only',
        env,
        ...(source.stdin === null ? {} : { stdin: new TextEncoder().encode(source.stdin) }),
        maxStdinBytes: MAX_STDIN_BYTES,
        signal: this.lifetime.signal,
        stop: { target: 'group', signal: 'SIGTERM', graceMs: ORDINARY_STOP_GRACE_MS },
        onLeaderSettled: (event) =>
          status.resolve('exitCode' in event ? exitStatus(event.exitCode, event.signal) : 1),
      });
    } catch (error) {
      await this.sendError('error', unclassifiedFailure('exec', startFailure(this.profile.bin, error)));
      this.finish();
      return;
    }
    const command = this.command;
    const leaderStatus = Promise.race([
      status.promise,
      command.result.then(
        () => 1,
        () => 1,
      ),
    ]);

    const timeout = setTimeout(() => void this.cancel('timeout', true), this.invoke.open.timeoutMs);
    try {
      const stdoutRun =
        this.profile.format.mode === 'ndjson'
          ? this.reader.readFramed(command.stdout, this.profile.format.stableCursor)
          : this.reader.readRaw(command.stdout, 'stdout');
      await Promise.all([command.result, stdoutRun, this.reader.readRaw(command.stderr, 'stderr')]);
      const code = await leaderStatus;
      if (this.cancelled) {
        if (this.reportCancellation) await this.sendEnd(code, this.cancellationReason);
        return;
      }
      await this.sendEnd(code, 'completed');
    } catch (error) {
      if (!this.cancelled) {
        if (error instanceof NativeCommandError && error.code === 'COMMAND_UNAVAILABLE') {
          await this.sendError('error', unclassifiedFailure('exec', startFailure(this.profile.bin, error)));
          return;
        }
        const reason = error instanceof ProducerFailure ? error.reason : 'error';
        await this.cancel(reason, false);
        await this.sendError(reason, producerRefusal(reason, String(error)));
        // A reported timeout or credit cancellation must still emit a terminal frame when it
        // wakes the credit wait by throwing before the normal completion branch.
      } else if (this.reportCancellation) {
        this.reportCancellation = false;
        await this.sendEnd(await leaderStatus, this.cancellationReason);
      }
    } finally {
      clearTimeout(timeout);
      this.finish();
    }
  }

  private async runService(): Promise<void> {
    const source = this.invoke.open.source;
    if (source.kind !== 'service') return;
    if (this.serviceSource === null) throw new Error('service stream execution is not configured');
    try {
      const dispatched = await this.serviceSource.open();
      if (!dispatched.accepted) {
        const refused = serviceOutcomeRefusal(dispatched.outcome);
        await this.sendError(
          dispatched.outcome.status === 'failure' && dispatched.outcome.code === 'unsupported'
            ? 'unsupported'
            : 'error',
          refused,
        );
        return;
      }
      this.producerMaxBytes = dispatched.resolved.limits.responseBytes;
      if (!dispatched.response.ok || dispatched.response.body === null) {
        await this.sendError('error', unclassifiedFailure('exec', 'owner refused service stream response'));
        return;
      }
      await this.reader.readRaw(
        dispatched.response.body,
        'data',
        dispatched.resolved.operation.response.kind === 'stream'
          ? dispatched.resolved.operation.response.idleTimeoutMs
          : undefined,
      );
      await this.sendTail;
      if (!this.cancelled) await this.sendEnd(0, 'completed');
    } catch (error) {
      if (!this.cancelled) {
        const reason = this.serviceSource.timedOut()
          ? 'timeout'
          : error instanceof ProducerFailure
            ? error.reason
            : 'error';
        await this.sendError(reason, producerRefusal(reason, String(error)));
      }
    } finally {
      await this.serviceSource.close();
      this.finish();
    }
  }

  private queueBytes(
    channel: 'stdout' | 'stderr' | 'data',
    bytes: Uint8Array,
    cursor: string | null,
  ): Promise<void> {
    const queued = this.sendTail.then(() => this.sendBytes(channel, bytes, cursor));
    this.sendTail = queued.catch(() => {});
    return queued;
  }

  private async sendBytes(
    channel: 'stdout' | 'stderr' | 'data',
    bytes: Uint8Array,
    cursor: string | null,
  ): Promise<void> {
    await this.credit.wait(bytes.byteLength);
    const maxTotal = Math.min(this.producerMaxBytes, this.invoke.limits.maxStreamBytes);
    if (this.totalBytes + bytes.byteLength > maxTotal) {
      throw new ProducerFailure('limit', 'producer exceeded the stream total byte ceiling');
    }
    const chunk: StreamChunk = {
      streamId: this.invoke.open.streamId,
      from: this.invoke.open.to,
      seq: this.seq,
      channel,
      encoding: 'base64',
      data: Buffer.from(bytes).toString('base64'),
      bytes: bytes.byteLength,
      cursor,
    };
    const ack = await this.transport.chunk(chunk);
    if (!ack.ok) throw new ProducerFailure('error', `broker rejected stream chunk: ${ack.detail}`);
    this.credit.consume(bytes.byteLength);
    this.totalBytes += bytes.byteLength;
    this.seq += 1;
    if (cursor !== null) this.lastCursor = cursor;
  }

  private async sendEnd(code: number, reason: StreamTerminalReason): Promise<void> {
    await this.transport.end({
      streamId: this.invoke.open.streamId,
      from: this.invoke.open.to,
      lastSeq: this.seq - 1,
      code,
      reason,
      cursor: this.lastCursor,
    });
  }

  private async sendError(reason: StreamTerminalReason, refused: Refused): Promise<void> {
    await this.transport.error({
      streamId: this.invoke.open.streamId,
      from: this.invoke.open.to,
      ...refused,
      reason,
    });
  }

  private finish(): void {
    this.lifetime.abort();
    this.release();
    this.onDone();
  }
}
