import { implement } from 'stitchkit/server';
import { type EventDeliveryFrame, toLocalEventDelivery } from '../../../contracts/src/door/local-contract.ts';
import type { LocalEventPublish, LocalEventSubscribe } from '../../../contracts/src/door/requests.ts';
import { eventDoorContract } from '../../../contracts/src/door/streams.ts';
import type { EventAckSchema } from '../../../contracts/src/protocol/event.ts';
import { transportFailure } from '../../../contracts/src/protocol/failure.ts';
import { endOnDeparture } from './departure.ts';
import type { TracePublication } from './publication-trace.ts';

/** The source yields WIRE frames; the service below converts each one at the door. */
interface LocalEventSource {
  publishEvent(
    request: LocalEventPublish,
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof EventAckSchema.parse>>;
  subscribeEvents(request: LocalEventSubscribe): AsyncIterableIterator<EventDeliveryFrame>;
}

/**
 * The event door, mounted as a declared service rather than as raw routes.
 *
 * Both halves are described by the contract, so the path, the body reading, the byte ceiling and the
 * 400 come from a type and not from a hand-written loop.
 *
 * A subscription is quiet most of the time — that is a topic's normal state, not a fault — and
 * three separate things have to be right for that to work: the runtime's generic ten-second idle
 * timeout must be cleared, a keep-alive must go out while nothing is happening, and the headers
 * must be flushed at open so a consumer's `fetch` returns before the first event. The contract's
 * stream descriptor is that checklist made structural: a door that declares a stream gets all three.
 */
export function createEventDoorService(source: LocalEventSource, trace?: TracePublication) {
  return implement(eventDoorContract, {
    publish: async ({ input, signal }) => {
      // Measured from handler entry: the framework's parsing phase (body read, validation) runs
      // ahead of this point, so this elapsed does not include it.
      const start = performance.now();
      trace?.(input, 'door-received', { elapsedMs: 0 });
      const ack = await source.publishEvent(input, signal);
      trace?.(input, 'door-response-ready', {
        elapsedMs: performance.now() - start,
        outcome: ack.ok ? 'accepted' : ack.refusal !== 'none' ? 'refused' : 'failed',
        callerAborted: signal?.aborted ?? false,
      });
      return ack;
    },
    subscribe: ({ input, signal }) => {
      const deliveries = source.subscribeEvents(input);
      endOnDeparture(signal, deliveries);
      return {
        [Symbol.asyncIterator]: async function* () {
          let terminal = false;
          for await (const delivery of deliveries) {
            terminal ||= 'failure' in delivery;
            yield toLocalEventDelivery(delivery);
          }
          // Owner shutdown may close the source while the HTTP reader is still present.
          // Report a Wire terminal; a raw EOF is not successful subscription completion.
          if (!terminal && !signal.aborted)
            yield toLocalEventDelivery({
              subscriptionId: null,
              topic: input.topic,
              from: 'broker',
              ...transportFailure('lane-lost-after-dispatch', 'local event source closed'),
            });
        },
      };
    },
  });
}
