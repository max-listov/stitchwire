import type { EventError, EventFrame, EventGap } from '../../../contracts/src/protocol/event.ts';
import { eventGap } from '../../../contracts/src/protocol/event.ts';
import { transportFailure, unclassifiedFailure } from '../../../contracts/src/protocol/failure.ts';
import type { EventDelivery } from './event-consumer.ts';

interface LaneSource {
  id: string;
  iterator: AsyncIterableIterator<EventDelivery>;
  /**
   * A source that does not keep the subscription alive.
   *
   * Delivery inside the node never ends on its own: it simply waits for the next local publish,
   * which may be never. Counting it among the sources whose exhaustion ends the subscription would
   * leave a terminal refusal from every broker collected and never delivered — the consumer would
   * hang instead of being told it had been denied. So this source rides along and the brokers alone
   * decide when the subscription is over.
   */
  passive?: boolean;
}

/**
 * Merge independent volatile subscriptions without turning either broker into a leader. The
 * author tuple is the identity; broker-local subscription ids and delivery races are provenance,
 * never a reason to emit a payload twice.
 */
export class MultiHomeEventConsumer implements AsyncIterableIterator<EventDelivery> {
  private readonly queue: EventDelivery[] = [];
  private readonly capacityWaiters: Array<() => void> = [];
  private waiter: ((result: IteratorResult<EventDelivery>) => void) | null = null;
  private active: number;
  private terminal = false;
  private closing: Promise<void> | null = null;
  private currentBoot: string | null = null;
  private highSequence = -1;
  private nextBootId: string | null = null;
  private readonly terminalErrors: EventError[] = [];
  private readonly readyLanes = new Set<string>();
  /** The resume answer already handed to the consumer, and which lanes have given it. Every broker
   *  answers a resume independently, so without this a two-lane node resyncs twice per wake. */
  private resumeEcho: { bootId: string; fromSeq: number; toSeq: number; lanes: Set<string> } | null = null;

  constructor(
    readonly subscriptionId: string,
    readonly topic: string,
    private readonly sources: LaneSource[],
    private readonly maxBuffered: number,
    private readonly onDone: () => void = () => {},
    private readonly lifecycle = false,
  ) {
    this.active = sources.filter((source) => source.passive !== true).length;
    if (lifecycle) this.push(this.subscriptionState());
    for (const source of sources) void this.pump(source);
  }

  private normalize(delivery: EventDelivery, laneId: string): EventDelivery[] {
    if ('subscriptionState' in delivery) {
      if (delivery.subscriptionState === 'ready') this.readyLanes.add(laneId);
      else this.readyLanes.delete(laneId);
      return this.lifecycle ? [this.subscriptionState()] : [];
    }
    if ('failure' in delivery) {
      this.terminalErrors.push(delivery);
      if (this.readyLanes.delete(laneId) && this.lifecycle) return [this.subscriptionState()];
      return [];
    }
    if ('seq' in delivery) {
      this.resumeEcho = null;
      return this.normalizeEvent(delivery);
    }
    if (
      delivery.reason === 'boot-change' &&
      delivery.bootId === this.currentBoot &&
      this.nextBootId !== null &&
      delivery.nextBootId !== this.nextBootId
    ) {
      // Two lanes can have skipped different intermediate boots. UUIDs have no chronology:
      // choosing one arbitrarily could rewind, while ignoring both would wedge forever.
      this.push({
        subscriptionId: this.subscriptionId,
        topic: this.topic,
        from: 'broker',
        ...unclassifiedFailure('transport', 'divergent boot boundaries require a fresh subscription'),
      });
      this.terminal = true;
      void this.finish();
      return [];
    }
    if (this.isLaneEcho(delivery, laneId)) return [];
    const gap = this.normalizeGap(delivery);
    return gap === null ? [] : [gap];
  }

  private subscriptionState(): EventDelivery {
    return {
      subscriptionId: this.subscriptionId,
      topic: this.topic,
      subscriptionState: this.readyLanes.size > 0 ? 'ready' : 'opening',
      lanes: [...this.readyLanes].sort(),
    };
  }

  /**
   * Is this the same resume answer a different lane already gave?
   *
   * A resume gap means "resync", and the contract says a consumer answers it by taking a snapshot.
   * Two brokers each answer the subscription honestly and identically, so passing both on costs a
   * second snapshot for one wake. The lane is what separates an echo from a genuine repeat: the same
   * lane saying it twice means it really happened twice, and any other delivery in between ends the
   * window, so a later resume on the same range is never swallowed.
   */
  private isLaneEcho(gap: EventGap, laneId: string): boolean {
    if (gap.reason !== 'resume') {
      this.resumeEcho = null;
      return false;
    }
    const echo = this.resumeEcho;
    if (
      echo !== null &&
      echo.bootId === gap.bootId &&
      echo.fromSeq === gap.fromSeq &&
      echo.toSeq === gap.toSeq
    ) {
      if (!echo.lanes.has(laneId)) {
        echo.lanes.add(laneId);
        return true;
      }
    }
    this.resumeEcho = {
      bootId: gap.bootId,
      fromSeq: gap.fromSeq,
      toSeq: gap.toSeq,
      lanes: new Set([laneId]),
    };
    return false;
  }

  private normalizeEvent(event: EventFrame): EventDelivery[] {
    let inferredGap: EventGap | null = null;
    if (this.currentBoot === null) {
      this.currentBoot = event.bootId;
      this.highSequence = event.seq;
    } else if (event.bootId === this.currentBoot) {
      if (event.seq <= this.highSequence) return [];
      if (event.seq > this.highSequence + 1) {
        inferredGap = eventGap({
          subscriptionId: this.subscriptionId,
          topic: event.topic,
          producer: event.producer,
          bootId: event.bootId,
          fromSeq: this.highSequence + 1,
          toSeq: event.seq - 1,
          reason: 'overflow',
        });
      }
      this.highSequence = event.seq;
    } else {
      if (event.bootId !== this.nextBootId) return [];
      // A resumed lane learns about a boot change late, so the new epoch may already have run past
      // zero. Insisting on sequence zero here would wedge the topic forever: the frame is refused,
      // the epoch never switches, and every later frame is refused for the same reason.
      this.currentBoot = event.bootId;
      this.nextBootId = null;
      if (event.seq > 0) {
        inferredGap = eventGap({
          subscriptionId: this.subscriptionId,
          topic: event.topic,
          producer: event.producer,
          bootId: event.bootId,
          fromSeq: 0,
          toSeq: event.seq - 1,
          reason: 'resume',
        });
      }
      this.highSequence = event.seq;
    }
    const normalized = { ...event, subscriptionId: this.subscriptionId };
    return inferredGap === null ? [normalized] : [inferredGap, normalized];
  }

  private normalizeGap(gap: EventGap): EventGap | null {
    if (this.currentBoot === null) {
      this.currentBoot = gap.bootId;
      this.highSequence = gap.toSeq;
      if (gap.reason === 'boot-change') this.nextBootId = gap.nextBootId ?? null;
      return eventGap({ ...gap, subscriptionId: this.subscriptionId });
    }
    if (gap.bootId !== this.currentBoot) {
      if (gap.reason !== 'boot-change' || gap.bootId !== this.nextBootId) return null;
      // A named successor may itself end before any of its frames reaches this reader.
      this.currentBoot = gap.bootId;
      this.highSequence = gap.toSeq;
      this.nextBootId = null;
    }
    if (gap.reason === 'boot-change') {
      if (this.nextBootId !== null || gap.nextBootId === undefined) return null;
      // Each lane ends at its own accepted sequence; local delivery may already be ahead.
      // The boundary authorizes one named successor, never an arbitrary late epoch.
      this.nextBootId = gap.nextBootId;
      return eventGap({ ...gap, subscriptionId: this.subscriptionId });
    }
    if (gap.toSeq <= this.highSequence) {
      // A `resume` gap at or behind the cursor is not stale duplication — it is the broker saying
      // it cannot vouch for continuity from here. Pass it on so the consumer resyncs, and leave the
      // cursor where it is, because nothing was proven lost.
      return gap.reason === 'resume' ? eventGap({ ...gap, subscriptionId: this.subscriptionId }) : null;
    }
    // `toSeq > highSequence` is guaranteed by the branch above, so the recomputed `fromSeq` cannot
    // pass `toSeq`. The factory makes that a checked fact rather than a deduction from a neighbour.
    const normalized = eventGap({
      ...gap,
      subscriptionId: this.subscriptionId,
      fromSeq: Math.max(gap.fromSeq, this.highSequence + 1),
    });
    this.highSequence = gap.toSeq;
    return normalized;
  }

  /**
   * Wait for the reader to take something, and why this one is allowed to wait without a deadline.
   *
   * It is bounded, just not by a timer here: a lane that stops reading stops acknowledging the
   * broker's deliveries, and the broker ends that subscription at `subscriberIdleMs` with an
   * explicit `timeout`. The deadline exists, it is declared per topic, and it belongs on the side
   * that can tell a slow subscriber from a quiet topic. Adding a second one here would give the
   * same failure two different verdicts depending on which fired first.
   *
   * Written down because "bounded elsewhere by contract" and "unbounded because nobody thought
   * about it" look identical in code.
   *
   * The LOCAL source is deliberately not covered by that argument — it has no broker to time it out
   * — which is why its queue discards instead of blocking. See `local-events.ts`.
   */
  private async waitForCapacity(): Promise<void> {
    if (this.queue.length < this.maxBuffered || this.waiter !== null || this.terminal) return;
    await new Promise<void>((resolve) => this.capacityWaiters.push(resolve));
  }

  private releaseCapacity(): void {
    if (this.queue.length >= this.maxBuffered) return;
    for (const resolve of this.capacityWaiters.splice(0)) resolve();
  }

  private async pump(source: LaneSource): Promise<void> {
    try {
      for (;;) {
        await this.waitForCapacity();
        if (this.terminal) return;
        const next = await source.iterator.next();
        if (next.done) return;
        const deliveries = this.normalize(next.value, source.id);
        for (const delivery of deliveries) {
          await this.waitForCapacity();
          if (this.terminal) return;
          this.push(delivery);
        }
      }
    } finally {
      if (source.passive !== true) {
        if (this.readyLanes.delete(source.id) && this.lifecycle && !this.terminal)
          this.push(this.subscriptionState());
        this.active -= 1;
        if (this.active === 0 && !this.terminal) {
          const representative = this.terminalErrors[0];
          this.push(
            representative === undefined
              ? {
                  subscriptionId: this.subscriptionId,
                  topic: this.topic,
                  from: 'broker',
                  ...transportFailure('no-connected-lane', 'all broker lanes are unavailable'),
                }
              : { ...representative, subscriptionId: this.subscriptionId },
          );
          this.terminal = true;
          await this.finish();
        }
      }
    }
  }

  private push(delivery: EventDelivery): void {
    const waiter = this.waiter;
    if (waiter !== null) {
      this.waiter = null;
      waiter({ done: false, value: delivery });
    } else {
      this.queue.push(delivery);
    }
  }

  next(): Promise<IteratorResult<EventDelivery>> {
    const delivery = this.queue.shift();
    if (delivery !== undefined) {
      this.releaseCapacity();
      return Promise.resolve({ done: false, value: delivery });
    }
    if (this.terminal) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => {
      this.waiter = resolve;
    });
  }

  async return(): Promise<IteratorResult<EventDelivery>> {
    this.terminal = true;
    this.queue.length = 0;
    this.waiter?.({ done: true, value: undefined });
    this.waiter = null;
    await this.finish();
    return { done: true, value: undefined };
  }

  private finish(): Promise<void> {
    if (this.closing !== null) return this.closing;
    for (const release of this.capacityWaiters.splice(0)) release();
    this.closing = Promise.all(this.sources.map((source) => source.iterator.return?.())).then(() => {
      this.onDone();
    });
    return this.closing;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<EventDelivery> {
    return this;
  }
}
