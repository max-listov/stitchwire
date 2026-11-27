import { z } from 'zod';
import { TopicNameSchema } from '../protocol/event.ts';
import { LocalVersionSchema } from './common.ts';

/** Admission of this handle, not producer health or domain freshness. */
export const EventSubscriptionStateSchema = z
  .strictObject({
    subscriptionId: z.uuid(),
    topic: TopicNameSchema,
    subscriptionState: z.enum(['opening', 'ready']),
    lanes: z.array(z.string().min(1).max(128)).max(64),
  })
  .refine(
    (value) =>
      (value.subscriptionState === 'ready') === value.lanes.length > 0 &&
      new Set(value.lanes).size === value.lanes.length,
    { message: 'ready requires distinct acknowledged lanes; opening requires none' },
  );
export type EventSubscriptionState = z.infer<typeof EventSubscriptionStateSchema>;
export const LocalEventSubscriptionStateSchema = EventSubscriptionStateSchema.safeExtend({
  v: LocalVersionSchema,
});
