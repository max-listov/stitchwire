import { defineContract } from 'stitchkit';
import { LOCAL_CALL_ENVELOPE_BYTES } from './request-bounds.ts';
import type { EventSubscriptionState } from './event-lifecycle.ts';
import { PeerObservationSchema, PeerRequestSchema } from '../peer-contract.ts';
import type { EventError, EventFrame, EventGap } from '../protocol/event.ts';
import type { Result } from '../protocol/rpc.ts';
import type { StreamChunk, StreamEnd, StreamError } from '../protocol/stream.ts';
import { LOCAL_API_VERSION } from './common.ts';
import { LocalCallSchema } from './requests.ts';
import {
  LocalResultSchema,
  LocalStreamEventSchema,
  LocalEventDeliverySchema,
  type LocalResult,
  type LocalStreamEvent,
  type LocalEventDelivery,
} from './results.ts';
import { LocalStatusSchema } from './status.ts';

/** What the node hands over internally: a wire frame. The three functions below are the ONLY place
 *  the wire's version is swapped for the door's, so no other file has to remember that these are two
 *  contracts which merely happen to carry the same fields today. */
export type StreamConsumerFrame = StreamChunk | StreamEnd | StreamError;
export type EventDeliveryFrame = EventFrame | EventGap | EventError | EventSubscriptionState;

export function toLocalResult(result: Result): LocalResult {
  return { ...result, v: LOCAL_API_VERSION };
}

export function toLocalStreamEvent(event: StreamConsumerFrame): LocalStreamEvent {
  return LocalStreamEventSchema.parse({ ...event, v: LOCAL_API_VERSION });
}

export function toLocalEventDelivery(delivery: EventDeliveryFrame): LocalEventDelivery {
  return LocalEventDeliverySchema.parse({ ...delivery, v: LOCAL_API_VERSION });
}

export const localContract = defineContract(
  { prefix: 'wire' },
  {
    peerObservation: {
      method: 'POST',
      path: '/peer-observation',
      desc: 'Bounded native caller-to-peer RTT on a declared broker route',
      input: PeerRequestSchema,
      output: PeerObservationSchema,
    },
    call: {
      method: 'POST',
      path: '/call',
      desc: 'Run an allowed command on another node and return its result',
      input: LocalCallSchema,
      maxJsonBodyBytes: LOCAL_CALL_ENVELOPE_BYTES,
      output: LocalResultSchema,
    },
    status: {
      method: 'GET',
      path: '/status',
      desc: 'This agent’s link to the broker and the roster it can see',
      output: LocalStatusSchema,
    },
  },
);
