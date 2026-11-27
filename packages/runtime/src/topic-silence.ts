import type { BrokerHealth } from '../../local-client/src/contracts.ts';

type TopicHealth = BrokerHealth['topics'][number];

/** What a silence verdict reads of a topic; the policy and the cadence may be unobserved. */
export type TopicSilenceObservation = Pick<TopicHealth, 'publisherLive' | 'sinceLastPublishMs'> &
  Partial<Pick<TopicHealth, 'publicationMode' | 'cadence'>>;

/** Five observed intervals, with a one-minute noise floor and the conservative thirty-minute
 * ceiling. Fewer than three observations carry no usable cadence evidence. */
export function topicSilenceThreshold(cadence: { count: number; windowMs: number } | undefined): number {
  if (!cadence || cadence.count < 3 || cadence.windowMs < 1_000) return 1_800_000;
  return Math.min(1_800_000, Math.max(60_000, (5 * cadence.windowMs) / (cadence.count - 1)));
}

/** A burst cannot establish a heartbeat obligation. Unknown policy is not healthy or silent, and a
 * policy this release does not recognize is unknown policy. */
export function topicSilenceState(
  topic: TopicSilenceObservation,
): 'not-live' | 'unknown-policy' | 'on-change' | 'flowing' | 'silent' {
  if (!topic.publisherLive) return 'not-live';
  switch (topic.publicationMode) {
    case 'on-change':
      return 'on-change';
    case 'periodic':
      return topic.sinceLastPublishMs === null ||
        topic.sinceLastPublishMs > topicSilenceThreshold(topic.cadence)
        ? 'silent'
        : 'flowing';
    case 'unknown':
    case 'unrecognized':
    case undefined:
      return 'unknown-policy';
    default:
      return topic.publicationMode satisfies never;
  }
}
