import { createBoundedAdmission } from 'stitchkit/application';
import type { LocalEventSubscribe } from '../../../contracts/src/door/requests.ts';
import { capacityRefusal, type Refused } from '../../../contracts/src/protocol/failure.ts';
import type { NodeConfig } from '../config/node.ts';
import type { LaneAgent } from './agent-contract.ts';
import type { EventDelivery } from './event-consumer.ts';
import { eventTopicRefusal, topicAllowance } from './event-policy.ts';
import { type LaneRetryPolicy, ResilientLaneEventIterator } from './lane-event-iterator.ts';
import type { LocalEventBus } from './local-events.ts';
import { MultiHomeEventConsumer } from './multi-home-events.ts';
import { SharedEventSource, type SharedEventReader } from './shared-event-source.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';

async function* refusedSubscription(topic: string, refused: Refused): AsyncIterableIterator<EventDelivery> {
  yield { subscriptionId: null, topic, from: 'broker', ...refused };
}

/** A logical reader holds one lease across all lanes, including offline retry periods. */
export class EventSubscriptions {
  private readonly slots;
  private readonly consumers = new Set<SharedEventReader>();
  private readonly live = new Map<string, SharedEventSource>();
  private readonly retiring = new Set<Promise<void>>();

  constructor(
    private readonly config: NodeConfig,
    private readonly lanes: readonly {
      endpoint: { id: string };
      agent: Pick<LaneAgent, 'connected' | 'terminal' | 'subscribeEvents'>;
    }[],
    private readonly localBus: LocalEventBus,
    private readonly retry?: LaneRetryPolicy,
  ) {
    this.slots = createBoundedAdmission({
      policy: { global: { maxConcurrent: config.admission.maxEventSubscriptions } },
    });
  }

  open(request: LocalEventSubscribe): AsyncIterableIterator<EventDelivery> {
    const denied = eventTopicRefusal(
      topicAllowance(this.config.events, 'subscribe'),
      request.topic,
      'subscribe',
    );
    if (denied !== null) return refusedSubscription(request.topic, denied);
    const admitted = this.slots.acquire();
    if (admitted.outcome === 'refused')
      return refusedSubscription(
        request.topic,
        capacityRefusal('node logical event subscription limit reached or admission stopped'),
      );
    const maxBuffered = this.config.admission.maxEventBufferedPerSubscription;
    // Historical resumes need their own broker answer, even when cursors happen to match.
    let source = request.resume === null ? this.live.get(request.topic) : undefined;
    if (source === undefined) {
      const created: SharedEventSource = new SharedEventSource(
        request.topic,
        maxBuffered,
        () => this.createSource({ ...request, lifecycle: true }, maxBuffered),
        (closed) => {
          if (this.live.get(request.topic) === created) this.live.delete(request.topic);
          this.retiring.add(closed);
          void closed.then(
            () => this.retiring.delete(closed),
            () => this.retiring.delete(closed),
          );
        },
      );
      source = created;
      if (request.resume === null) this.live.set(request.topic, created);
    }
    const consumer: SharedEventReader = source.open(request.lifecycle === true, () => {
      this.consumers.delete(consumer);
      admitted.lease.release();
    });
    this.consumers.add(consumer);
    return consumer;
  }

  private createSource(request: LocalEventSubscribe, maxBuffered: number): MultiHomeEventConsumer {
    const id = crypto.randomUUID();
    return new MultiHomeEventConsumer(
      id,
      request.topic,
      [
        { id: 'local', iterator: this.localBus.open(request.topic, id, maxBuffered), passive: true },
        ...this.lanes.map((lane) => ({
          id: lane.endpoint.id,
          iterator: new ResilientLaneEventIterator(lane.agent, request, this.retry),
        })),
      ],
      maxBuffered,
      () => {},
      true,
    );
  }

  snapshot() {
    return subscriptionSnapshot(this.consumers);
  }

  async drain(): Promise<void> {
    this.slots.stopAdmission();
    await Promise.all([...this.consumers].map((consumer) => consumer.return()));
    await Promise.all(this.retiring);
    await this.slots.drain();
  }
}

/** Counts and enumeration come from one synchronous observation of the live handles. */
export function subscriptionSnapshot(readers: Iterable<{ subscriptionId: string; topic: string }>) {
  const subscriptions = [...readers].map(({ subscriptionId, topic }) => ({ subscriptionId, topic }));
  const byTopic = new Map<string, number>();
  for (const { topic } of subscriptions) byTopic.set(topic, (byTopic.get(topic) ?? 0) + 1);
  return {
    observedAt: nowIso(),
    activeSubscriptions: subscriptions.length,
    subscriptions,
    topics: [...byTopic]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([topic, activeSubscriptions]) => ({ topic, activeSubscriptions })),
  };
}
