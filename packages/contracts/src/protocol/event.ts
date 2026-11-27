import { z } from 'zod';

import { NodeIdSchema } from './identity.ts';
import {
  FailureSchema,
  NOT_REFUSED,
  RefusalSchema,
  RefusalFields,
  type Refused,
  refusalRefinement,
} from './failure.ts';
import { base64PayloadRefinement, utf8ByteLength } from './payload.ts';
import { MAX_EVENT_BYTES, MAX_TOPIC_NAME_BYTES } from './bounds.ts';
export const TopicNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/)
  .superRefine((topic, ctx) => {
    if (utf8ByteLength(topic) > MAX_TOPIC_NAME_BYTES) {
      ctx.addIssue({ code: 'custom', message: `topic exceeds ${MAX_TOPIC_NAME_BYTES} bytes` });
    }
  });

/**
 * What a returning subscriber knows: the producer boot it was following and the last sequence it
 * actually saw. It is a claim about the subscriber's own past, never a demand — the broker answers
 * with whatever it still holds and names the rest as a gap. A resume for a boot the broker no longer
 * knows is not an error either; it is simply a gap that starts at the beginning of the new epoch.
 */
export const EventResumeSchema = z.object({ bootId: z.uuid(), afterSeq: z.number().int().min(0) }).strict();
export type EventResume = z.infer<typeof EventResumeSchema>;

export const EventSubscribeSchema = z
  .object({
    subscriptionId: z.uuid(),
    topic: TopicNameSchema,
    subscriber: NodeIdSchema,
    /** Null is a first subscription: start live, claim nothing about the past. */
    resume: EventResumeSchema.nullable(),
  })
  .strict();
export type EventSubscribe = z.infer<typeof EventSubscribeSchema>;

export const EventUnsubscribeSchema = z
  .object({
    subscriptionId: z.uuid(),
    topic: TopicNameSchema,
    subscriber: NodeIdSchema,
    reason: z.string().min(1).max(512),
  })
  .strict();
export type EventUnsubscribe = z.infer<typeof EventUnsubscribeSchema>;

export const EventPayloadFields = {
  topic: TopicNameSchema,
  producer: NodeIdSchema,
  bootId: z.uuid(),
  seq: z.number().int().min(0),
  observedAt: z.iso.datetime().nullable(),
  cursor: z.string().min(1).max(512).nullable(),
  encoding: z.literal('base64'),
  data: z.string().max(Math.ceil((MAX_EVENT_BYTES * 4) / 3) + 4),
  bytes: z.number().int().min(1).max(MAX_EVENT_BYTES),
};

export const EventPublishSchema = z
  .object({ ...EventPayloadFields })
  .strict()
  .superRefine(base64PayloadRefinement);
export type EventPublish = z.infer<typeof EventPublishSchema>;

export const EventFrameSchema = z
  .object({ subscriptionId: z.uuid(), ...EventPayloadFields })
  .strict()
  .superRefine(base64PayloadRefinement);
export type EventFrame = z.infer<typeof EventFrameSchema>;

/**
 * Why a subscriber is missing sequences. The reason is not decoration: an operator reading
 * `overflow` goes and raises `queueDepth`, which is the wrong repair for a laptop that was asleep.
 *
 *  - `latest-wins` — the topic coalesces by declaration; the skipped events were superseded.
 *  - `overflow`    — the subscriber could not keep up and its bounded queue dropped frames.
 *  - `boot-change` — the producer restarted; the previous epoch ends here.
 *  - `resume`      — the subscriber came back and the topic retains nothing. Expected, not a fault.
 *  - `retention`   — the subscriber came back past the retention window; the head is gone.
 */
export const EventGapReasonSchema = z.enum(['latest-wins', 'overflow', 'boot-change', 'resume', 'retention']);
/** The field list of a gap, shared so the door's view cannot drift from the wire's. */
export const EventGapFields = {
  subscriptionId: z.uuid(),
  topic: TopicNameSchema,
  producer: NodeIdSchema,
  bootId: z.uuid(),
  fromSeq: z.number().int().min(0),
  toSeq: z.number().int().min(0),
  reason: EventGapReasonSchema,
  nextBootId: z.uuid().optional(),
} as const;

/**
 * The two things a gap must satisfy and TypeScript cannot express.
 *
 * `nextBootId` is optional in the inferred type, so nothing but a refinement can say that it is
 * required for `boot-change` and forbidden otherwise; and nothing but a refinement can say that a
 * range runs forwards. They are exported because the door declares its own gap shape, and a copy
 * of the fields WITHOUT these two once meant a locally built gap reached a consumer unchecked.
 */
export const eventGapRangeIsOrdered = (gap: { fromSeq: number; toSeq: number }): boolean =>
  gap.toSeq >= gap.fromSeq;
export const EVENT_GAP_RANGE_MESSAGE = 'gap sequence range is inverted';
export const eventGapBootTransitionIsExact = (gap: {
  reason: string;
  bootId: string;
  nextBootId?: string | undefined;
}): boolean =>
  gap.reason === 'boot-change'
    ? gap.nextBootId !== undefined && gap.nextBootId !== gap.bootId
    : gap.nextBootId === undefined;
export const EVENT_GAP_BOOT_MESSAGE = 'boot transition requires its exact successor';

export const EventGapSchema = z
  .object(EventGapFields)
  .strict()
  .refine(eventGapRangeIsOrdered, { message: EVENT_GAP_RANGE_MESSAGE })
  .refine(eventGapBootTransitionIsExact, { message: EVENT_GAP_BOOT_MESSAGE });

export type EventGap = z.infer<typeof EventGapSchema>;

/**
 * The only place a gap is built.
 *
 * A gap was assembled as an object literal in six places across the broker and the node — three of
 * them inside one file, two of them on a path that never reached the schema. An eight-field shape
 * with two invariants that the compiler cannot check is exactly the shape that must have one
 * constructor: here the invariants are enforced at construction, not at whichever exit happens to
 * validate.
 */
export function eventGap(gap: EventGap): EventGap {
  return EventGapSchema.parse(gap);
}

export const EventErrorSchema = z
  .object({
    subscriptionId: z.uuid().nullable(),
    topic: TopicNameSchema,
    from: z.literal('broker'),
    failure: FailureSchema,
    ...RefusalFields,
    detail: z.string().max(4_096),
  })
  .strict()
  .superRefine(refusalRefinement);
export type EventError = z.infer<typeof EventErrorSchema>;

export const EventAckSchema = z
  .object({
    ok: z.boolean(),
    failure: FailureSchema,
    ...RefusalFields,
    detail: z.string().max(4_096),
  })
  .strict()
  .superRefine(refusalRefinement);
export type EventAck = z.infer<typeof EventAckSchema>;

/** An accepted event operation. */
export const acceptedEventAck = (): EventAck => ({ ok: true, ...NOT_REFUSED });
/** A refused one, carrying the refusal as it was classified. */
export const rejectedEventAck = (refused: Refused): EventAck => ({ ok: false, ...refused });

export const EventDeliveryAckSchema = z
  .object({
    accepted: z.boolean(),
    /** A subscriber that refuses a frame knows WHY — a closed subscription and a full queue are not
     *  the same answer. Without this the broker can only report "the subscriber said no", and the
     *  one piece of information that decides whether the producer should slow down is lost one hop
     *  from where it was known. */
    refusal: RefusalSchema,
    detail: z.string().max(512),
  })
  .strict();
export type EventDeliveryAck = z.infer<typeof EventDeliveryAckSchema>;
