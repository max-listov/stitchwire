import { createBoundedChannel } from 'stitchkit/application';
import { MAX_EVENT_BYTES } from '../../../contracts/src/protocol/bounds.ts';
import type { EventFrame, EventGap } from '../../../contracts/src/protocol/event.ts';
import { eventGap } from '../../../contracts/src/protocol/event.ts';
import { eventDeliverySize } from '../event-delivery-size.ts';
import { wireLogger } from '../logger.ts';
import type { EventDelivery } from './event-consumer.ts';

/**
 * Delivery that never leaves the machine.
 *
 * A node that publishes a topic it also reads must not send its own event to a broker and wait for
 * it to come back. Measured by the consumer that reported it: 124 ms from a REMOTE publisher, and
 * **467 ms from the same node as the subscriber** — the local case four times slower than the
 * remote one, precisely because it was not local. Worse than the latency, delivery inside one
 * machine would depend on reaching a machine somewhere else.
 *
 * The shape follows from the ordering question the report raised, and the answer to it: this
 * transport never promised an order BETWEEN consumers — two subscribers on different machines
 * already see an event at different times, and two brokers deliver independently. What it does
 * promise is the order within one producer's stream for one subscriber, and a topic has exactly one
 * producer.
 *
 * So a local delivery is not a second path. It is one more **source** of the same consumer, sitting
 * beside the broker lanes, and the merge that already reconciles two brokers reconciles this too:
 * `MultiHomeEventConsumer` drops anything at or below the sequence it has seen, so whichever copy
 * arrives first wins and the other is discarded as the duplicate it is. Nothing had to learn a new
 * rule for this to be correct.
 */
export class LocalEventLane implements AsyncIterableIterator<EventDelivery> {
  private readonly channel;
  private lastFrame: Pick<EventFrame, 'bootId' | 'seq'> | null = null;
  private pendingFrame: EventFrame | null = null;
  private closed = false;

  private droppedCount = 0;

  constructor(
    readonly subscriptionId: string,
    private readonly maxBuffered: number,
    private readonly onClose: () => void = () => {},
    private readonly log: (line: string) => void = (line) => wireLogger.error(line),
  ) {
    this.channel = createBoundedChannel<EventFrame>({
      policy: 'ordered',
      maxItems: maxBuffered,
      maxBytes: maxBuffered * (MAX_EVENT_BYTES * 2 + 8192),
      sizeOf: eventDeliverySize,
    });
  }

  /** How many frames this lane discarded because its reader was not keeping up. */
  get dropped(): number {
    return this.droppedCount;
  }

  /**
   * Hand an event to this subscriber.
   *
   * Bounded, and the bound is the point. Every other queue on this path has one — the broker's
   * subscriber queue, the node's per-subscription buffer — and an unbounded one here would grow
   * until the process died whenever a local consumer stops reading without closing. That is the same
   * defect class as a wait with no deadline, wearing the other face: unbounded growth and unbounded
   * waiting are both a state that looks like work.
   *
   * Overflow DISCARDS rather than blocks, and that is safe here for a reason specific to this lane:
   * it is an accelerator, not a source of guarantee. The same event is on its way through the
   * brokers, whose path carries the credit accounting and the explicit gap, and the merge will take
   * whichever copy survives. Blocking instead would push back on the publisher for the benefit of
   * one slow local reader — turning a latency optimisation into a fleet-wide stall.
   *
   * Dropped frames are counted and the first one is announced, because a silent discard is exactly
   * the shape this whole class of defect takes.
   */
  push(frame: EventFrame): void {
    if (this.closed) return;
    if (this.channel.offer(frame).outcome === 'refused') {
      this.droppedCount += 1;
      if (this.droppedCount === 1) {
        this.log(
          `[wire] local delivery for '${frame.topic}' is behind: buffer of ${this.maxBuffered} is full, dropping. The broker copy still carries this event.`,
        );
      }
      return;
    }
  }

  next(): Promise<IteratorResult<EventDelivery>> {
    const pending = this.pendingFrame;
    if (pending !== null) {
      this.pendingFrame = null;
      this.lastFrame = { bootId: pending.bootId, seq: pending.seq };
      return Promise.resolve({ done: false, value: pending });
    }
    return this.channel
      .next()
      .then((next) =>
        next.done ? { done: true, value: undefined } : { done: false, value: this.deliver(next.value) },
      );
  }

  async return(): Promise<IteratorResult<EventDelivery>> {
    if (!this.closed) {
      this.closed = true;
      this.onClose();
    }
    this.channel.close({ mode: 'discard' });
    this.pendingFrame = null;
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<EventDelivery> {
    return this;
  }

  /** Emit a boundary together with the next surviving frame, so queue overflow cannot lose it. */
  private deliver(frame: EventFrame): EventFrame | EventGap {
    const previous = this.lastFrame;
    if (previous !== null && previous.bootId !== frame.bootId) {
      this.pendingFrame = frame;
      return eventGap({
        subscriptionId: this.subscriptionId,
        topic: frame.topic,
        producer: frame.producer,
        bootId: previous.bootId,
        nextBootId: frame.bootId,
        fromSeq: previous.seq,
        toSeq: previous.seq,
        reason: 'boot-change',
      });
    }
    this.lastFrame = { bootId: frame.bootId, seq: frame.seq };
    return frame;
  }
}

/**
 * Which local subscribers are reading which topic.
 *
 * Deliberately a plain registry rather than a broker of its own: it holds no sequence state, no
 * retention and no admission. Every one of those already exists exactly once, on the broker, and a
 * second implementation of them inside the node would be a second source of truth for the hardest
 * part of this transport.
 */
export class LocalEventBus {
  private readonly byTopic = new Map<string, Set<LocalEventLane>>();

  open(topic: string, subscriptionId: string, maxBuffered: number): LocalEventLane {
    const lane: LocalEventLane = new LocalEventLane(subscriptionId, maxBuffered, () =>
      this.close(topic, lane),
    );
    const lanes = this.byTopic.get(topic) ?? new Set<LocalEventLane>();
    lanes.add(lane);
    this.byTopic.set(topic, lanes);
    return lane;
  }

  private close(topic: string, lane: LocalEventLane): void {
    const lanes = this.byTopic.get(topic);
    if (lanes === undefined) return;
    lanes.delete(lane);
    if (lanes.size === 0) this.byTopic.delete(topic);
  }

  /** How many local subscribers this topic has right now — the fact that decides whether a publish
   *  has anywhere local to go, and the number a publish reports having reached. */
  subscribers(topic: string): number {
    return this.byTopic.get(topic)?.size ?? 0;
  }

  /** Each subscriber is handed the frame under ITS OWN subscription id, exactly as a broker would
   *  address it — so a consumer cannot tell a local delivery from a remote one, and does not have
   *  to. */
  publish(frame: Omit<EventFrame, 'subscriptionId'>): number {
    const lanes = this.byTopic.get(frame.topic);
    if (lanes === undefined) return 0;
    for (const lane of lanes) lane.push({ ...frame, subscriptionId: lane.subscriptionId });
    return lanes.size;
  }
}
