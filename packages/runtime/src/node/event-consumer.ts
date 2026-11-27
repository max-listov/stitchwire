import { createBoundedChannel } from 'stitchkit/application';
import { eventDeliverySize } from '../event-delivery-size.ts';
import type { EventSubscriptionState } from '../../../contracts/src/door/event-lifecycle.ts';
import { MAX_EVENT_BYTES } from '../../../contracts/src/protocol/bounds.ts';
import type {
  EventDeliveryAck,
  EventError,
  EventFrame,
  EventGap,
  EventUnsubscribe,
} from '../../../contracts/src/protocol/event.ts';
import type { NodeId } from '../../../contracts/src/protocol/identity.ts';

export type EventDelivery = EventFrame | EventGap | EventError | EventSubscriptionState;

interface EventConsumerTransport {
  unsubscribe(request: EventUnsubscribe): Promise<void>;
}

export class EventConsumer implements AsyncIterableIterator<EventDelivery> {
  private readonly channel;
  private terminal = false;

  constructor(
    readonly subscriptionId: string,
    readonly topic: string,
    private readonly subscriber: NodeId,
    private readonly maxBuffered: number,
    private readonly transport: EventConsumerTransport,
    private readonly onDone: () => void,
  ) {
    this.channel = createBoundedChannel<EventDelivery>({
      policy: 'ordered',
      maxItems: maxBuffered + 2,
      maxBytes: (maxBuffered + 2) * (MAX_EVENT_BYTES * 2 + 8192),
      sizeOf: eventDeliverySize,
    });
  }

  push(delivery: EventDelivery): EventDeliveryAck {
    if (this.terminal) {
      return { accepted: false, refusal: 'none', detail: 'local subscription is closed' };
    }
    // A terminal delivery is not data, so the data queue's ceiling has no authority over it. It is
    // the ONLY thing that releases this subscription's slot on the node, and the bound this class
    // documents in `next()` — the broker's `subscriberIdleMs` — is delivered by exactly this frame.
    // Refusing it for capacity meant a subscriber that stopped reading could never be ended by
    // anyone: measured on the fleet as 32 held slots against 8 live consumers, and beside it in the
    // node log, `buffer of 64 is full, dropping`. One frame past the ceiling is bounded — there is
    // never a second, because this one closes the subscription.
    const terminal = 'failure' in delivery;
    if (
      !terminal &&
      !('subscriptionState' in delivery) &&
      this.channel.getSnapshot().queuedItems >= this.maxBuffered
    ) {
      // Capacity, and the producer side can act on it: the subscription itself is healthy.
      return { accepted: false, refusal: 'capacity', detail: 'local subscriber queue limit reached' };
    }
    const offered = this.channel.offer(delivery);
    if (offered.outcome === 'refused')
      return { accepted: false, refusal: 'capacity', detail: 'local subscriber queue limit reached' };
    if (terminal) {
      this.terminal = true;
      this.channel.close();
      this.onDone();
    }
    return { accepted: true, refusal: 'none', detail: '' };
  }

  /**
   * Waits without a deadline, deliberately: silence is a topic's normal state, and a subscription
   * that timed out its own reader would turn "nothing happened" into a fault. The bound that does
   * exist is the broker's `subscriberIdleMs`, which ends a subscription whose deliveries are not
   * acknowledged — it can tell a slow subscriber from a quiet topic, and this side cannot.
   */
  next(): Promise<IteratorResult<EventDelivery>> {
    return this.channel.next();
  }

  async return(): Promise<IteratorResult<EventDelivery>> {
    this.channel.close({ mode: 'discard' });
    if (!this.terminal) {
      this.terminal = true;
      await this.transport.unsubscribe({
        subscriptionId: this.subscriptionId,
        topic: this.topic,
        subscriber: this.subscriber,
        reason: 'local consumer closed',
      });
      this.onDone();
    }
    return { done: true, value: undefined };
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<EventDelivery> {
    return this;
  }
}
