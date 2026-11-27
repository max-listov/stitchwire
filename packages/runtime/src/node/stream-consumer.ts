import { createBoundedChannel } from 'stitchkit/application';
import {
  capacityRefusal,
  type Refused,
  unclassifiedFailure,
} from '../../../contracts/src/protocol/failure.ts';
import type { NodeId } from '../../../contracts/src/protocol/identity.ts';
import type {
  StreamAck,
  StreamCancel,
  StreamChunk,
  StreamEnd,
  StreamError,
  StreamLimits,
  StreamWindow,
} from '../../../contracts/src/protocol/stream.ts';

export type StreamConsumerEvent = StreamChunk | StreamEnd | StreamError;

interface ConsumerTransport {
  window(window: StreamWindow): Promise<StreamAck>;
  cancel(cancel: StreamCancel): Promise<StreamAck>;
}

export class StreamConsumer implements AsyncIterableIterator<StreamConsumerEvent> {
  private readonly channel;
  private expectedSeq = 0;
  private terminal = false;
  private started = false;
  private cancellation: Promise<StreamAck> | undefined;

  constructor(
    readonly streamId: string,
    private readonly nodeId: NodeId,
    private readonly maxBufferedBytes: number,
    private readonly transport: ConsumerTransport,
    private readonly onDone: () => void,
  ) {
    this.channel = createBoundedChannel<StreamConsumerEvent>({
      policy: 'ordered',
      maxItems: maxBufferedBytes + 1,
      maxBytes: maxBufferedBytes,
      sizeOf: (value) => ('seq' in value ? value.bytes : 0),
    });
  }

  async start(limits: StreamLimits): Promise<void> {
    if (this.terminal || this.started) return;
    this.started = true;
    const creditBytes = Math.min(this.maxBufferedBytes, limits.maxWindowBytes);
    const ack = await this.transport.window({
      streamId: this.streamId,
      from: this.nodeId,
      creditBytes,
    });
    if (!ack.ok) {
      this.failLocal(
        unclassifiedFailure('transport', `initial stream window rejected: ${ack.detail}`),
        'error',
      );
    }
  }

  pushChunk(chunk: StreamChunk): void {
    if (this.terminal) return;
    if (chunk.seq !== this.expectedSeq) {
      this.fail(
        unclassifiedFailure(
          'rejected',
          `local consumer expected sequence ${this.expectedSeq}, received ${chunk.seq}`,
        ),
      );
      return;
    }
    if (this.channel.offer(chunk).outcome === 'refused') {
      this.fail(capacityRefusal('local stream buffer ceiling exceeded', null, 'rejected'));
      return;
    }
    this.expectedSeq += 1;
  }

  pushEnd(end: StreamEnd): void {
    if (this.terminal) return;
    if (end.lastSeq !== this.expectedSeq - 1) {
      this.fail(unclassifiedFailure('rejected', 'stream terminal sequence does not match local delivery'));
      return;
    }
    this.terminal = true;
    this.channel.offer(end);
    this.channel.close();
    this.onDone();
  }

  pushFailure(error: StreamError): void {
    if (this.terminal) return;
    this.terminal = true;
    this.channel.offer(error);
    this.channel.close();
    this.onDone();
  }

  /** Local termination also withdraws a possibly dispatched producer, even before admission ACK. */
  abort(error: StreamError): void {
    if (this.terminal) return;
    this.pushFailure(error);
    void this.cancel(error.detail);
  }

  private cancel(reason: string): Promise<StreamAck> {
    this.cancellation ??= this.transport.cancel({ streamId: this.streamId, from: this.nodeId, reason });
    return this.cancellation;
  }

  /**
   * Waits without a deadline, deliberately: a stream's producer may be quiet for as long as its
   * profile allows. The bounds are the stream's own — `timeoutMs`, `maxBytes` and the broker's
   * slow-consumer deadline — all of which end this iterator with an explicit terminal event rather
   * than with a silence that has to be guessed at.
   */
  async next(): Promise<IteratorResult<StreamConsumerEvent>> {
    const next = await this.channel.next();
    if (!next.done) this.replenish(next.value);
    return next;
  }

  async return(): Promise<IteratorResult<StreamConsumerEvent>> {
    this.channel.close({ mode: 'discard' });
    if (!this.terminal) {
      this.terminal = true;
      this.onDone();
      await this.cancel('local consumer closed');
    }
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<StreamConsumerEvent> {
    return this;
  }

  private replenish(event: StreamConsumerEvent): void {
    if (!('seq' in event)) return;
    if (this.terminal) return;
    void this.transport.window({
      streamId: this.streamId,
      from: this.nodeId,
      creditBytes: event.bytes,
    });
  }

  private fail(refused: Refused): void {
    this.failLocal(refused, 'limit');
  }

  private failLocal(refused: Refused, reason: StreamError['reason']): void {
    this.abort({
      streamId: this.streamId,
      from: 'broker',
      ...refused,
      reason,
    });
  }
}
