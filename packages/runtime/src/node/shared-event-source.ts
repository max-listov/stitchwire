import { createBoundedChannel } from 'stitchkit/application';
import { MAX_EVENT_BYTES } from '../../../contracts/src/protocol/bounds.ts';
import { capacityRefusal, transportFailure } from '../../../contracts/src/protocol/failure.ts';
import { eventDeliverySize } from '../event-delivery-size.ts';
import { wireLogger } from '../logger.ts';
import type { EventDelivery } from './event-consumer.ts';

/** Each local reader owns its capacity and lease, never its neighbour's backpressure. */
export class SharedEventReader implements AsyncIterableIterator<EventDelivery> {
  private readonly channel;
  private closed = false;
  private terminal: EventDelivery | null = null;

  constructor(
    readonly subscriptionId: string,
    readonly topic: string,
    maxBuffered: number,
    private readonly lifecycle: boolean,
    private readonly detach: () => Promise<void>,
  ) {
    this.channel = createBoundedChannel<EventDelivery>({
      policy: 'ordered',
      maxItems: maxBuffered,
      maxBytes: maxBuffered * (MAX_EVENT_BYTES * 2 + 8192),
      sizeOf: eventDeliverySize,
    });
  }

  push(delivery: EventDelivery): void {
    if (this.closed || ('subscriptionState' in delivery && !this.lifecycle)) return;
    if ('failure' in delivery) {
      this.finish({ ...delivery, subscriptionId: this.subscriptionId });
      return;
    }
    const offered = this.channel.offer({ ...delivery, subscriptionId: this.subscriptionId });
    if (offered.outcome !== 'refused') return;
    this.finish({
      subscriptionId: this.subscriptionId,
      topic: this.topic,
      from: 'broker',
      ...capacityRefusal('local event reader buffer is full; resume or reconcile before continuing'),
    });
  }

  private finish(delivery: EventDelivery): void {
    this.closed = true;
    // One control slot outside the data queue survives its byte/item ceiling.
    this.terminal = delivery;
    this.channel.close();
    void this.detach();
  }

  async next(): Promise<IteratorResult<EventDelivery>> {
    const next = await this.channel.next();
    if (!next.done || this.terminal === null) return next;
    const value = this.terminal;
    this.terminal = null;
    return { done: false, value };
  }

  async return(): Promise<IteratorResult<EventDelivery>> {
    this.terminal = null;
    this.channel.close({ mode: 'discard' });
    if (!this.closed) {
      this.closed = true;
      await this.detach();
    }
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<EventDelivery> {
    return this;
  }
}

/** One merged upstream for compatible live readers. It stores lifecycle, never payload history. */
export class SharedEventSource {
  private readonly readers = new Set<SharedEventReader>();
  private source: AsyncIterableIterator<EventDelivery> | null = null;
  private state: Extract<EventDelivery, { subscriptionState: string }>;
  private closing: Promise<void> | null = null;

  constructor(
    private readonly topic: string,
    private readonly maxBuffered: number,
    private readonly create: () => AsyncIterableIterator<EventDelivery>,
    private readonly onEmpty: (closed: Promise<void>) => void,
  ) {
    this.state = { subscriptionId: crypto.randomUUID(), topic, subscriptionState: 'opening', lanes: [] };
  }

  open(lifecycle: boolean, onDone: () => void): SharedEventReader {
    const reader: SharedEventReader = new SharedEventReader(
      crypto.randomUUID(),
      this.topic,
      this.maxBuffered,
      lifecycle,
      async () => {
        if (!this.readers.delete(reader)) return;
        onDone();
        if (this.readers.size === 0) await this.close();
      },
    );
    this.readers.add(reader);
    reader.push(this.state);
    if (this.source === null) {
      this.source = this.create();
      void this.pump(this.source);
    }
    return reader;
  }

  private async pump(source: AsyncIterableIterator<EventDelivery>): Promise<void> {
    try {
      for await (const delivery of source) {
        if (this.closing !== null) break;
        if ('subscriptionState' in delivery) {
          if (
            delivery.subscriptionState === this.state.subscriptionState &&
            delivery.lanes.join('\0') === this.state.lanes.join('\0')
          )
            continue;
          this.state = delivery;
        }
        for (const reader of this.readers) reader.push(delivery);
      }
    } catch (error) {
      wireLogger.error('event upstream failed', { error, topic: this.topic });
    } finally {
      // A source must never strand quiet readers when every lane has ended.
      for (const reader of this.readers)
        reader.push({
          subscriptionId: null,
          topic: this.topic,
          from: 'broker',
          ...transportFailure('no-connected-lane', 'event upstream ended'),
        });
      await this.close();
    }
  }

  private close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.closing = Promise.resolve().then(async () => {
      await this.source?.return?.();
    });
    this.onEmpty(this.closing);
    return this.closing;
  }
}
