import { z } from 'zod';
import { MAX_EVENT_BYTES, MAX_TOPIC_RETAIN_AGE_MS, MAX_TOPIC_RETAINED_BYTES } from './bounds.ts';
import { TopicNameSchema } from './event.ts';
import { NodeIdSchema } from './identity.ts';
import { schemaParse } from './schema-parse.ts';

/**
 * Who decides what about a topic.
 *
 * The fleet decides who may send to whom, and what that may cost a broker: a namespace granted to
 * one producer, with a ceiling on how many topics fit inside it. The owner of the producing
 * application decides what it actually sends: the names inside that namespace and each topic's
 * profile. It is the border services already have — the fleet grants a pair, the owner's descriptor
 * declares the operations — and it exists for the same reason: an owner adding a topic should not
 * have to ask whoever edits the fleet's configuration.
 */

/**
 * How much of a topic's recent past the broker keeps so a subscriber that comes back can be handed
 * it instead of a hole. Both zero — the default — keeps nothing.
 *
 * The ring belongs to the TOPIC, not to a subscriber. That is the whole reason this is affordable:
 * a node that never returns costs nothing, because there is no mailbox with its name on it. Two
 * bounds and not three — an event is already capped by `maxEventBytes`, so a count would be a third
 * knob defending nothing, while age and bytes each answer a different failure: value decaying, and
 * one loud topic evicting every other.
 */
export const TopicRetentionSchema = z
  .object({
    maxAgeMs: z.number().int().min(0).max(MAX_TOPIC_RETAIN_AGE_MS).default(0),
    maxBytes: z.number().int().min(0).max(MAX_TOPIC_RETAINED_BYTES).default(0),
  })
  .strict()
  .superRefine((retain, ctx) => {
    // Half a pair is a trap: one bound set and the other zero reads as "retention is on" and
    // behaves as "retention is off", and the operator finds out from a gap months later.
    if ((retain.maxAgeMs === 0) !== (retain.maxBytes === 0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'retention needs both maxAgeMs and maxBytes, or neither',
      });
    }
  });

/** What a topic is, apart from who produces it and who may read it. */
const TopicProfileFields = {
  delivery: z.enum(['latest-wins', 'ordered']),
  /** Publication frequency is observed, but the obligation to publish is declared. */
  publicationMode: z.enum(['periodic', 'on-change']).optional(),
  maxEventBytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_EVENT_BYTES)
    .default(64 * 1024),
  maxEventsPerSecond: z.number().int().min(1).max(60_000).default(100),
  maxSubscribers: z.number().int().min(1).max(256).default(32),
  queueDepth: z.number().int().min(1).max(1_024).default(64),
  subscriberIdleMs: z.number().int().min(1_000).max(300_000).default(30_000),
  retain: TopicRetentionSchema.default({ maxAgeMs: 0, maxBytes: 0 }),
};

const SubscribersSchema = z.array(NodeIdSchema).min(1).max(256);

function topicRefinement(
  topic: { subscribers?: string[] | undefined; delivery: string; retain: { maxBytes: number } },
  ctx: z.RefinementCtx,
): void {
  if (topic.subscribers !== undefined && new Set(topic.subscribers).size !== topic.subscribers.length) {
    ctx.addIssue({ code: 'custom', path: ['subscribers'], message: 'topic subscribers must be unique' });
  }
  // `latest-wins` says only the newest value matters; retention says the ones before it do too.
  // Accepting both would silently pick one, so the contradiction is refused where it is written.
  if (topic.delivery === 'latest-wins' && topic.retain.maxBytes > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['retain'],
      message: 'a latest-wins topic cannot retain: coalescing and replay contradict each other',
    });
  }
}

/** A topic the broker routes: its producer, its readers and its profile. */
export const TopicDeclarationSchema = z
  .object({ producer: NodeIdSchema, subscribers: SubscribersSchema, ...TopicProfileFields })
  .strict()
  .superRefine(topicRefinement);
export type TopicDeclaration = z.infer<typeof TopicDeclarationSchema>;

/**
 * A namespace ends where a name segment ends. `owner.node.` holds `owner.node.checks` and cannot be
 * mistaken for a grant over `owner.nodes.checks`, which a bare string prefix would silently cover.
 */
const TOPIC_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,126}[.:]$/;

export const TopicNamespaceSchema = z
  .string()
  .regex(TOPIC_NAMESPACE_PATTERN, 'a namespace is a topic-name prefix ending in "." or ":"');

/**
 * Whether `topic` lies inside `namespace`: the namespace is one `TopicNamespaceSchema` accepts — the
 * same pattern, not a second reading of it — and the topic continues past it.
 */
export function isTopicInNamespace(namespace: string, topic: string): boolean {
  return (
    TOPIC_NAMESPACE_PATTERN.test(namespace) && topic.length > namespace.length && topic.startsWith(namespace)
  );
}

export type TopicAccessMode = 'publish' | 'subscribe';

export interface TopicAuthorizationGrants {
  readonly publish?: readonly string[];
  readonly subscribe?: readonly string[];
  readonly namespaces?: {
    readonly publish?: readonly string[];
    readonly subscribe?: readonly string[];
  };
}

/** Shared single-direction match used by both node enforcement and SDK authorization helpers. */
export function isTopicMatchedByGrants(
  topic: string,
  exact: readonly string[] | undefined,
  namespaces: readonly string[] | undefined,
): boolean {
  if (exact?.includes(topic) === true) return true;
  return namespaces?.some((namespace) => isTopicInNamespace(namespace, topic)) === true;
}

/** Whether `topic` is granted in `mode` either by exact listing or by a granted namespace prefix. */
export function isTopicAuthorized(
  topic: string,
  events: TopicAuthorizationGrants,
  mode: TopicAccessMode,
): boolean {
  return isTopicMatchedByGrants(
    topic,
    mode === 'publish' ? events.publish : events.subscribe,
    mode === 'publish' ? events.namespaces?.publish : events.namespaces?.subscribe,
  );
}

/** Two namespaces overlap when one could hold a name of the other. */
export function namespacesOverlap(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

export const MAX_DECLARED_TOPICS = 256;
/** Topic descriptor files one node configuration binds; each file may declare several topics. */
export const MAX_TOPIC_DESCRIPTOR_FILES = 16;
/** Maximum byte size of a single topic descriptor JSON file accepted by the node agent. */
export const TOPIC_MAX_DESCRIPTOR_BYTES = 64 * 1024;

/**
 * A topic profile as its owner declares it. The producer is whoever sends the declaration, so it is
 * not written here; the readers default to everyone the namespace admits, and may be narrowed.
 */
export const TopicProfileSchema = z
  .object({ subscribers: SubscribersSchema.optional(), ...TopicProfileFields })
  .strict()
  .superRefine(topicRefinement);
export type TopicProfile = z.infer<typeof TopicProfileSchema>;
export type TopicProfileInput = z.input<typeof TopicProfileSchema>;

const DeclaredTopicsSchema = z
  .record(TopicNameSchema, TopicProfileSchema)
  .refine((topics) => Object.keys(topics).length <= MAX_DECLARED_TOPICS, {
    message: `at most ${MAX_DECLARED_TOPICS} topics may be declared at once`,
  });

/** The file an owner installs beside its application, and binds a node to. */
export const TopicDescriptorSchema = z.object({ topics: DeclaredTopicsSchema }).strict();
export type TopicDescriptor = z.infer<typeof TopicDescriptorSchema>;
export type TopicDescriptorInput = z.input<typeof TopicDescriptorSchema>;

/** Validates a parsed topic descriptor the way the node agent does, with the same one-line reason. */
export const parseTopicDescriptor = schemaParse(TopicDescriptorSchema);

/**
 * Node → broker: the complete set of topics this producer declares. Complete, not incremental — a
 * topic missing from a later declaration is withdrawn, so the broker never holds a name its owner
 * has already removed.
 */
export const EventDeclareSchema = z.object({ producer: NodeIdSchema, topics: DeclaredTopicsSchema }).strict();
export type EventDeclare = z.infer<typeof EventDeclareSchema>;

export const EventDeclareRefusalSchema = z
  .object({ topic: TopicNameSchema, detail: z.string().min(1).max(512) })
  .strict();
export type EventDeclareRefusal = z.infer<typeof EventDeclareRefusalSchema>;

/** Per name: accepted, or refused with the reason the owner needs to repair it. */
export const EventDeclareAckSchema = z
  .object({
    accepted: z.array(TopicNameSchema).max(MAX_DECLARED_TOPICS),
    refused: z.array(EventDeclareRefusalSchema).max(MAX_DECLARED_TOPICS),
  })
  .strict();
export type EventDeclareAck = z.infer<typeof EventDeclareAckSchema>;
