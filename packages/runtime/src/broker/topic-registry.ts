import { ownEntry } from '../json.ts';
import type { NodeId } from '../../../contracts/src/protocol/identity.ts';
import {
  type EventDeclare,
  type EventDeclareAck,
  type EventDeclareRefusal,
  isTopicInNamespace,
  type TopicDeclaration,
  TopicDeclarationSchema,
  type TopicProfile,
} from '../../../contracts/src/protocol/topic.ts';
import type { BrokerConfig, TopicNamespaceGrant } from '../config/broker.ts';

/** Where a topic came from: the fleet's configuration, or its owner's declaration. */
export type TopicSource = 'fleet' | 'owner';

export type TopicLookup =
  | { state: 'declared'; declaration: TopicDeclaration; source: TopicSource }
  /** Inside a granted namespace, but its producer has not declared it — yet, or any more. */
  | { state: 'undeclared'; namespace: string; producer: NodeId }
  | { state: 'unknown' };

interface RegisteredTopic {
  name: string;
  declaration: TopicDeclaration;
  source: TopicSource;
}

/**
 * Every topic this broker routes, from both places a topic can come from.
 *
 * Fleet topics are fixed by configuration. Owner topics arrive from their producer, inside a
 * namespace the configuration granted to that producer, and live until the same producer declares
 * again: each declaration replaces the previous one whole. Nothing here is persisted — after a
 * restart the producer's next connection declares again, and until then its names answer
 * `undeclared`, which a subscriber is told to wait out rather than give up on.
 */
export class TopicRegistry {
  private readonly declared = new Map<NodeId, Map<string, TopicDeclaration>>();

  constructor(private readonly config: Pick<BrokerConfig, 'topics' | 'topicNamespaces'>) {}

  lookup(name: string): TopicLookup {
    const fleet = ownEntry(this.config.topics, name);
    if (fleet !== undefined) return { state: 'declared', declaration: fleet, source: 'fleet' };
    const namespace = this.namespaceOf(name);
    if (namespace === undefined) return { state: 'unknown' };
    const [prefix, grant] = namespace;
    const owned = this.declared.get(grant.producer)?.get(name);
    return owned === undefined
      ? { state: 'undeclared', namespace: prefix, producer: grant.producer }
      : { state: 'declared', declaration: owned, source: 'owner' };
  }

  resolve(name: string): TopicDeclaration | undefined {
    const found = this.lookup(name);
    return found.state === 'declared' ? found.declaration : undefined;
  }

  entries(): RegisteredTopic[] {
    const fleet = Object.entries(this.config.topics).map(
      ([name, declaration]): RegisteredTopic => ({ name, declaration, source: 'fleet' }),
    );
    const owned = [...this.declared.values()].flatMap((topics) =>
      [...topics].map(([name, declaration]): RegisteredTopic => ({ name, declaration, source: 'owner' })),
    );
    return [...fleet, ...owned].sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Replace everything this producer declared. Each name is judged on its own, so one bad entry
   * costs the owner that entry and a reason, not the whole file. Returns the names that stopped
   * existing, so the state kept for them can be released, and the topics that still exist under a
   * different declaration, so what was granted under the old one can be judged again.
   */
  declare(
    nodeId: NodeId,
    request: EventDeclare,
  ): { ack: EventDeclareAck; withdrawn: string[]; changed: Map<string, TopicDeclaration> } {
    const names = Object.keys(request.topics).sort();
    if (request.producer !== nodeId)
      return {
        ack: {
          accepted: [],
          refused: names.map((topic) => ({
            topic,
            detail: 'declaring identity does not match the authenticated socket',
          })),
        },
        withdrawn: [],
        changed: new Map(),
      };
    const accepted: string[] = [];
    const refused: EventDeclareRefusal[] = [];
    const next = new Map<string, TopicDeclaration>();
    const usage = new Map<string, { topics: number; retainedBytes: number }>();
    for (const name of names) {
      const topic = request.topics[name];
      if (topic === undefined) continue;
      const verdict = this.admit(nodeId, name, topic, usage);
      if (typeof verdict === 'string') refused.push({ topic: name, detail: verdict });
      else {
        next.set(name, verdict);
        accepted.push(name);
      }
    }
    const previous = this.declared.get(nodeId) ?? new Map<string, TopicDeclaration>();
    if (next.size === 0) this.declared.delete(nodeId);
    else this.declared.set(nodeId, next);
    const changed = new Map<string, TopicDeclaration>();
    for (const [name, declaration] of next) {
      const before = previous.get(name);
      if (before !== undefined && JSON.stringify(before) !== JSON.stringify(declaration))
        changed.set(name, declaration);
    }
    return {
      ack: { accepted, refused },
      withdrawn: [...previous.keys()].filter((name) => !next.has(name)),
      changed,
    };
  }

  private admit(
    nodeId: NodeId,
    name: string,
    topic: TopicProfile,
    usage: Map<string, { topics: number; retainedBytes: number }>,
  ): TopicDeclaration | string {
    if (ownEntry(this.config.topics, name) !== undefined)
      return 'the fleet configuration already declares this topic';
    const namespace = this.namespaceOf(name);
    if (namespace === undefined) return `no namespace on this broker holds this name`;
    const [prefix, grant] = namespace;
    if (grant.producer !== nodeId) return `namespace '${prefix}' is granted to ${grant.producer}`;
    const subscribers = topic.subscribers ?? grant.subscribers;
    const outside = subscribers.filter((subscriber) => !grant.subscribers.includes(subscriber));
    if (outside.length > 0)
      return `namespace '${prefix}' does not admit ${outside[0]} (${outside.length} outside subscriber(s))`;
    const used = usage.get(prefix) ?? { topics: 0, retainedBytes: 0 };
    if (used.topics + 1 > grant.maxTopics)
      return `namespace '${prefix}' holds at most ${grant.maxTopics} topics`;
    if (used.retainedBytes + topic.retain.maxBytes > grant.maxRetainedBytes)
      return `namespace '${prefix}' may retain at most ${grant.maxRetainedBytes} bytes in total`;
    usage.set(prefix, { topics: used.topics + 1, retainedBytes: used.retainedBytes + topic.retain.maxBytes });
    return TopicDeclarationSchema.parse({ ...topic, producer: nodeId, subscribers });
  }

  /** Configuration refuses overlapping namespaces, so a name has at most one. */
  private namespaceOf(name: string): [string, TopicNamespaceGrant] | undefined {
    return Object.entries(this.config.topicNamespaces).find(([prefix]) => isTopicInNamespace(prefix, name));
  }
}
