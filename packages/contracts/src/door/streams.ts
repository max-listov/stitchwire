import { defineContract, type EndpointStreamDescriptor } from 'stitchkit';
import { z } from 'zod';
import { DOOR_MAX_FRAME_BYTES } from '../protocol/bounds.ts';
import {
  LOCAL_STREAM_ENVELOPE_BYTES,
  LOCAL_PUBLISH_ENVELOPE_BYTES,
  LOCAL_SUBSCRIBE_ENVELOPE_BYTES,
} from './request-bounds.ts';
import { LocalEventPublishSchema, LocalEventSubscribeSchema, LocalStreamRequestSchema } from './requests.ts';
import { EventAckSchema } from '../protocol/event.ts';
import {
  LocalEventDeliverySchema,
  LocalEventErrorSchema,
  LocalStreamEventSchema,
  LocalStreamEndSchema,
  LocalStreamErrorSchema,
} from './results.ts';

/** Wire owns its frames; Kit owns framing, bounded parsing and terminal lifetime. */
export function itemStream<T>(
  item: z.ZodType<T>,
  terminal: z.ZodType,
  maxFrameBytes = DOOR_MAX_FRAME_BYTES,
): EndpointStreamDescriptor<z.ZodType<T>> {
  return {
    item,
    terminal,
    format: 'ndjson',
    framing: 'item',
    completion: 'terminal',
    finalLine: 'require-newline',
    maxFrameBytes,
  };
}

export const streamDoorContract = defineContract(
  { prefix: 'wire' },
  {
    stream: {
      method: 'POST',
      path: '/stream',
      desc: 'Bounded command stream',
      input: LocalStreamRequestSchema,
      maxJsonBodyBytes: LOCAL_STREAM_ENVELOPE_BYTES,
      stream: itemStream(LocalStreamEventSchema, z.union([LocalStreamEndSchema, LocalStreamErrorSchema])),
    },
  },
);
export const eventDoorContract = defineContract(
  { prefix: 'wire/events' },
  {
    /**
     * Publishing is described by the contract like every other door endpoint: `maxJsonBodyBytes`
     * is its byte ceiling, and the body reader and the refusal come with it.
     */
    publish: {
      method: 'POST',
      path: '/publish',
      desc: 'Publish one bounded event on a declared topic',
      input: LocalEventPublishSchema,
      output: EventAckSchema,
      maxJsonBodyBytes: LOCAL_PUBLISH_ENVELOPE_BYTES,
    },
    subscribe: {
      method: 'POST',
      path: '/subscribe',
      desc: 'Quiet live events with explicit gaps',
      input: LocalEventSubscribeSchema,
      maxJsonBodyBytes: LOCAL_SUBSCRIBE_ENVELOPE_BYTES,
      stream: itemStream(LocalEventDeliverySchema, LocalEventErrorSchema),
    },
  },
);
