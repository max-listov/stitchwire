import type { EventSubscriptionState } from '../../contracts/src/door/event-lifecycle.ts';
import type { EventError, EventFrame, EventGap } from '../../contracts/src/protocol/event.ts';

/** Exact JSON size of a validated delivery: canonical base64 is ASCII and needs no escaping. */
export function eventDeliverySize(
  delivery: EventFrame | EventGap | EventError | EventSubscriptionState,
): number {
  if ('data' in delivery)
    return delivery.data.length + Buffer.byteLength(JSON.stringify({ ...delivery, data: '' }));
  return Buffer.byteLength(JSON.stringify(delivery));
}
