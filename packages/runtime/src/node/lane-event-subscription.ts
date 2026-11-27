import type { BoundedAdmission, BoundedOperationLease } from 'stitchkit/application';
import type { LocalEventSubscribe } from '../../../contracts/src/door/requests.ts';
import type {
  EventAck,
  EventDeliveryAck,
  EventSubscribe,
  EventUnsubscribe,
} from '../../../contracts/src/protocol/event.ts';
import { capacityRefusal, type Refused, transportFailure } from '../../../contracts/src/protocol/failure.ts';
import { EventConsumer } from './event-consumer.ts';
import { eventTopicRefusal, type TopicAllowance } from './event-policy.ts';
import { LANE_ACK_TIMEOUT_MS, type LaneClient } from './lane-contract.ts';

/** Delivery refusal for a missing subscription is not capacity: backoff cannot recreate it. */
export function bindLaneEventDelivery(
  client: LaneClient,
  consumers: ReadonlyMap<string, EventConsumer>,
): void {
  const missing = (): EventDeliveryAck => ({
    accepted: false,
    refusal: 'none',
    detail: 'unknown local subscription',
  });
  client.on('event:event', (event, acknowledge) =>
    acknowledge(consumers.get(event.subscriptionId)?.push(event) ?? missing()),
  );
  client.on('event:gap', (gap, acknowledge) =>
    acknowledge(consumers.get(gap.subscriptionId)?.push(gap) ?? missing()),
  );
  client.on('event:error', (error, acknowledge) => {
    const consumer = error.subscriptionId === null ? undefined : consumers.get(error.subscriptionId);
    acknowledge(consumer?.push(error) ?? missing());
  });
}

interface EventSubscriptionTransport {
  subscribe(request: EventSubscribe, acknowledge: (ack: EventAck) => void): boolean;
  unsubscribe(request: EventUnsubscribe, acknowledge: () => void): boolean;
}

/** Owns one lane subscription from local admission through broker acknowledgement and cleanup. */
export function openLaneEventSubscription(
  config: {
    nodeId: string;
    allowance: TopicAllowance;
    maxBuffered: number;
    /** How long the broker has to acknowledge; a test shortens it instead of waiting out the production value. */
    ackTimeoutMs?: number;
  },
  consumers: Map<string, EventConsumer>,
  slots: BoundedAdmission,
  transport: EventSubscriptionTransport,
  request: LocalEventSubscribe,
): EventConsumer {
  const subscriptionId = crypto.randomUUID();
  let slot: BoundedOperationLease | undefined;
  let admissionTimer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  let acknowledged = false;
  const consumer = new EventConsumer(
    subscriptionId,
    request.topic,
    config.nodeId,
    config.maxBuffered,
    {
      unsubscribe: (message) =>
        new Promise((resolve) => {
          let settled = false;
          const settle = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(settle, LANE_ACK_TIMEOUT_MS);
          if (!transport.unsubscribe(message, settle)) settle();
        }),
    },
    () => {
      ended = true;
      clearTimeout(admissionTimer);
      consumers.delete(subscriptionId);
      slot?.release();
    },
  );
  const fail = (refused: Refused): EventConsumer => {
    consumer.push({
      subscriptionId,
      topic: request.topic,
      from: 'broker',
      ...refused,
    });
    return consumer;
  };
  const denied = eventTopicRefusal(config.allowance, request.topic, 'subscribe');
  if (denied !== null) return fail(denied);
  const admitted = slots.acquire();
  if (admitted.outcome === 'refused')
    return fail(capacityRefusal('node local event subscription limit reached'));
  slot = admitted.lease;
  consumers.set(subscriptionId, consumer);
  admissionTimer = setTimeout(() => {
    fail(transportFailure('acknowledgement-timeout', 'broker subscription acknowledgement timed out'));
    // The broker may have taken the subscription and only its acknowledgement was lost; on a quiet
    // topic nothing else would ever end it, so it is withdrawn here, whether or not that is heard.
    transport.unsubscribe(
      {
        subscriptionId,
        topic: request.topic,
        subscriber: config.nodeId,
        reason: 'acknowledgement timed out',
      },
      () => {},
    );
  }, config.ackTimeoutMs ?? LANE_ACK_TIMEOUT_MS);
  const handed = transport.subscribe(
    {
      subscriptionId,
      topic: request.topic,
      subscriber: config.nodeId,
      resume: request.resume,
    },
    (ack) => {
      clearTimeout(admissionTimer);
      if (ended || acknowledged) return;
      acknowledged = true;
      if (!ack.ok)
        fail({
          failure: ack.failure,
          refusal: ack.refusal,
          retryAfterMs: ack.retryAfterMs,
          transportCause: ack.transportCause ?? null,
          detail: ack.detail,
        });
      else if (request.lifecycle)
        consumer.push({
          subscriptionId,
          topic: request.topic,
          subscriptionState: 'ready',
          lanes: ['broker'],
        });
    },
  );
  if (!handed) {
    clearTimeout(admissionTimer);
    return fail(transportFailure('no-connected-lane', 'not connected to the broker'));
  }
  return consumer;
}
