import type { LocalEventSubscribe } from '../../../contracts/src/door/requests.ts';
import type { EventResume } from '../../../contracts/src/protocol/event.ts';
import { transportFailure } from '../../../contracts/src/protocol/failure.ts';
import { wireLogger } from '../logger.ts';
import type { LaneAgent } from './agent-contract.ts';
import type { EventDelivery } from './event-consumer.ts';
export interface LaneRetryPolicy {
  minDelayMs: number;
  maxDelayMs: number;
  /** Fraction of the delay that is subtracted at random, so two lanes never retry in lockstep. */
  jitter: number;
}

export const DEFAULT_LANE_RETRY: LaneRetryPolicy = { minDelayMs: 250, maxDelayMs: 30_000, jitter: 0.2 };

/**
 * One lane's subscription, re-established across reconnects where it left off. Remembering the
 * cursor here is what turns a closed laptop from a subscriber
 * that quietly resumes mid-stream into one the broker can answer honestly the moment it returns.
 *
 * Without the cursor a loss is reported only when the next event happens to arrive, and under the
 * name `overflow` — a quiet topic could leave a woken machine believing nothing occurred for as
 * long as the producer stays silent.
 */
export class ResilientLaneEventIterator implements AsyncIterableIterator<EventDelivery> {
  private current: AsyncIterableIterator<EventDelivery> | null = null;
  private closed = false;
  private terminal = false;
  private cursor: EventResume | null;
  /** The next pause before re-subscribing. Zero means "the last attempt worked". */
  private backoffMs = 0;
  /** Attempts since the last delivered frame, for the line a person reads. */
  private attempts = 0;
  private wake: (() => void) | null = null;
  private retryReason: string | null = null;
  private subscriptionId: string = crypto.randomUUID();

  constructor(
    private readonly agent: Pick<LaneAgent, 'connected' | 'terminal' | 'subscribeEvents'>,
    private readonly request: LocalEventSubscribe,
    private readonly retry: LaneRetryPolicy = DEFAULT_LANE_RETRY,
    private readonly log: (line: string) => void = (line) => wireLogger.error(line),
  ) {
    this.cursor = request.resume;
  }

  /** A gap advances the cursor exactly like a frame: those sequences are accounted for — as lost. */
  private advance(delivery: EventDelivery): void {
    if ('failure' in delivery || 'subscriptionState' in delivery) return;
    const seq = 'seq' in delivery ? delivery.seq : delivery.toSeq;
    this.cursor =
      this.cursor === null || this.cursor.bootId !== delivery.bootId
        ? { bootId: delivery.bootId, afterSeq: seq }
        : { bootId: delivery.bootId, afterSeq: Math.max(this.cursor.afterSeq, seq) };
  }

  /**
   * Wait before trying the lane again, and say why.
   *
   * Measured without it: a lane that answered `transport` immediately produced **20 000
   * re-subscriptions in 3 ms**, and a 50 ms timer scheduled alongside never fired once — the retry
   * path was synchronous to the microtask, so it does not merely spin, it starves the event loop.
   * On the fleet only the round trip to the broker slowed it down, which is why it presents as a
   * well-behaved consumer polling three times a second rather than as the defect it is.
   *
   * Jitter is not decoration: two lanes of a multi-homed node fail together and would otherwise
   * retry in lockstep forever, turning one broker's bad minute into a synchronised pair of them.
   */
  private async pause(reason: string): Promise<void> {
    this.attempts += 1;
    this.backoffMs =
      this.backoffMs === 0 ? this.retry.minDelayMs : Math.min(this.backoffMs * 2, this.retry.maxDelayMs);
    const delay = Math.round(this.backoffMs * (1 - this.retry.jitter * Math.random()));
    // Every attempt, not only the first: a subscription that will never come back is the failure
    // this class exists to survive, and it must not survive it in silence.
    this.log(
      `[wire] subscription to '${this.request.topic}' lost (${reason}); attempt ${this.attempts}, retrying in ${delay}ms`,
    );
    await this.wait(delay);
  }

  private wait(delayMs: number): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      this.wake = finish;
    });
  }

  async next(): Promise<IteratorResult<EventDelivery>> {
    while (!this.closed && !this.terminal) {
      if (this.retryReason !== null) {
        const reason = this.retryReason;
        this.retryReason = null;
        await this.pause(reason);
        if (this.closed) break;
      }
      if (this.agent.terminal) {
        this.terminal = true;
        return {
          done: false,
          value: {
            subscriptionId: null,
            topic: this.request.topic,
            from: 'broker',
            ...transportFailure('no-connected-lane', 'broker lane is terminal'),
          },
        };
      }
      if (!this.agent.connected) {
        await this.wait(this.retry.minDelayMs);
        continue;
      }
      this.current ??= this.agent.subscribeEvents({ ...this.request, resume: this.cursor });
      const next = await this.current.next();
      // A consumer that went away closed this iterator first, and the lane ending is the CONSEQUENCE
      // of that, not a loss. Without this check a local reader disconnecting normally is announced
      // as a lost subscription and paid for with a pause nobody is waiting on — measured at seven
      // such lines a second on a node whose neighbour reopens its subscription in a loop.
      if (this.closed) return { done: true, value: undefined };
      if (next.done) {
        this.current = null;
        this.retryReason = 'the lane subscription ended';
        if (this.request.lifecycle) return this.opening();
        continue;
      }
      // `offline` on a subscription means the producer has not declared this topic on this broker
      // yet — after a broker restart, or before an owner's first declaration arrives. The name is
      // inside a namespace the fleet granted, so it is a wait, never a verdict.
      if (
        'failure' in next.value &&
        (next.value.failure === 'transport' || next.value.failure === 'offline')
      ) {
        await this.current.return?.();
        this.current = null;
        this.retryReason = `${next.value.refusal}: ${next.value.detail}`;
        if (this.request.lifecycle) return this.opening();
        continue;
      }
      if ('subscriptionState' in next.value) {
        this.subscriptionId = next.value.subscriptionId;
        return next;
      }
      if ('failure' in next.value) this.terminal = true;
      // A delivered frame is the only proof the lane works, so it is the only thing that clears
      // the backoff. Clearing it on a successful *subscribe* would reset the timer on precisely
      // the loop being defended against: every attempt there was accepted by the broker.
      this.backoffMs = 0;
      this.attempts = 0;
      this.advance(next.value);
      return next;
    }
    return { done: true, value: undefined };
  }

  private opening(): IteratorResult<EventDelivery> {
    return {
      done: false,
      value: {
        subscriptionId: this.subscriptionId,
        topic: this.request.topic,
        subscriptionState: 'opening',
        lanes: [],
      },
    };
  }

  async return(): Promise<IteratorResult<EventDelivery>> {
    this.closed = true;
    this.wake?.();
    await this.current?.return?.();
    this.current = null;
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<EventDelivery> {
    return this;
  }
}
