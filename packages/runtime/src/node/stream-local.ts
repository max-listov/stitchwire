import { implement } from 'stitchkit/server';
import { streamDoorContract } from '../../../contracts/src/door/streams.ts';
import { endOnDeparture } from './departure.ts';
import { type StreamConsumerFrame, toLocalStreamEvent } from '../../../contracts/src/door/local-contract.ts';
import type { LocalStreamRequest } from '../../../contracts/src/door/requests.ts';
import { transportFailure } from '../../../contracts/src/protocol/failure.ts';

/** The source yields WIRE frames; the route below converts each one at the door. */
interface LocalStreamSource {
  openStream(request: LocalStreamRequest): AsyncIterableIterator<StreamConsumerFrame>;
}

/**
 * A bounded stream, served with its own duration, byte, credit and cancellation limits.
 *
 * The three requirements of a long-lived body — clear the generic idle timeout, keep the connection
 * alive while the producer is quiet, flush the headers at open — come from the route primitive,
 * which also ABORTS a signal when the consumer
 * leaves — an offer, not a service: acting on it is this door's job, and `endOnDeparture` is where
 * that happens. A follow-style feed is quiet by design, and a quiet producer parks this generator
 * exactly where closing its iterator cannot reach it.
 */
export function createStreamDoorService(source: LocalStreamSource) {
  return implement(streamDoorContract, {
    stream: ({ input, signal }) => {
      const frames = source.openStream(input);
      endOnDeparture(signal, frames);
      return {
        [Symbol.asyncIterator]: async function* () {
          let terminal = false;
          let streamId: string = crypto.randomUUID();
          for await (const frame of frames) {
            streamId = frame.streamId;
            terminal ||= !('seq' in frame);
            yield toLocalStreamEvent(frame);
          }
          if (!terminal && !signal.aborted)
            yield toLocalStreamEvent({
              streamId,
              from: 'broker',
              ...transportFailure('lane-lost-after-dispatch', 'local stream source closed'),
              reason: 'disconnect',
            });
        },
      };
    },
  });
}
