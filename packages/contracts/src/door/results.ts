import { z } from 'zod';
import {
  TopicNameSchema,
  EventGapFields,
  EventPayloadFields,
  eventGapRangeIsOrdered,
  eventGapBootTransitionIsExact,
  EVENT_GAP_RANGE_MESSAGE,
  EVENT_GAP_BOOT_MESSAGE,
} from '../protocol/event.ts';
import { FailureSchema, RefusalFields } from '../protocol/failure.ts';
import { ResultFields, resultRefinement } from '../protocol/result.ts';
import { StreamChunkFields, StreamEndFields, StreamErrorFields } from '../protocol/stream.ts';
import { LocalVersionSchema } from './common.ts';
import { LocalEventSubscriptionStateSchema } from './event-lifecycle.ts';

/** A finished call, as the door reports it: the wire's result and the door version. */
export const LocalResultSchema = z
  .object({ v: LocalVersionSchema, ...ResultFields })
  .strict()
  .superRefine(resultRefinement);
export type LocalResult = z.infer<typeof LocalResultSchema>;

export const LocalStreamChunkSchema = z.object({ v: LocalVersionSchema, ...StreamChunkFields }).strict();
export const LocalStreamEndSchema = z.object({ v: LocalVersionSchema, ...StreamEndFields }).strict();
export const LocalStreamErrorSchema = z.object({ v: LocalVersionSchema, ...StreamErrorFields }).strict();

export const LocalStreamEventSchema = z.union([
  LocalStreamChunkSchema,
  LocalStreamEndSchema,
  LocalStreamErrorSchema,
]);
export type LocalStreamEvent = z.infer<typeof LocalStreamEventSchema>;

export const LocalEventFrameSchema = z
  .object({ v: LocalVersionSchema, subscriptionId: z.uuid(), ...EventPayloadFields })
  .strict();

/**
 * The door's gap: the wire's fields plus the door version, and the SAME two invariants.
 *
 * Derived, not copied: a gap built on the node, where nothing else validates it, could otherwise
 * reach a consumer with an inverted range or a `boot-change` carrying no successor.
 */
export const LocalEventGapSchema = z
  .object({ v: LocalVersionSchema, ...EventGapFields })
  .strict()
  .refine(eventGapRangeIsOrdered, { message: EVENT_GAP_RANGE_MESSAGE })
  .refine(eventGapBootTransitionIsExact, { message: EVENT_GAP_BOOT_MESSAGE });

export const LocalEventErrorSchema = z
  .object({
    v: LocalVersionSchema,
    subscriptionId: z.uuid().nullable(),
    topic: TopicNameSchema,
    from: z.literal('broker'),
    failure: FailureSchema,
    ...RefusalFields,
    detail: z.string().max(4_096),
  })
  .strict();

export const LocalEventDeliverySchema = z.union([
  LocalEventSubscriptionStateSchema,
  LocalEventFrameSchema,
  LocalEventGapSchema,
  LocalEventErrorSchema,
]);
export type LocalEventDelivery = z.infer<typeof LocalEventDeliverySchema>;
