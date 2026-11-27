import { policyRefusal, type Refused } from '../../../contracts/src/protocol/failure.ts';
import { isTopicMatchedByGrants } from '../../../contracts/src/protocol/topic.ts';

/**
 * What this node's configuration lets its local applications do with a topic in one direction:
 * exact names the fleet declared, and any name inside a namespace the fleet granted.
 */
export interface TopicAllowance {
  readonly topics: readonly string[];
  readonly namespaces: readonly string[];
}

export function topicAllowance(
  events: {
    publish: readonly string[];
    subscribe: readonly string[];
    namespaces: { publish: readonly string[]; subscribe: readonly string[] };
  },
  action: 'publish' | 'subscribe',
): TopicAllowance {
  return { topics: events[action], namespaces: events.namespaces[action] };
}

/** One policy decision shared by local acceleration and physical broker lanes. */
export function eventTopicRefusal(
  allowance: TopicAllowance,
  topic: string,
  action: 'publish' | 'subscribe',
): Refused | null {
  return isTopicMatchedByGrants(topic, allowance.topics, allowance.namespaces)
    ? null
    : policyRefusal(`topic is not declared for local ${action}`);
}
