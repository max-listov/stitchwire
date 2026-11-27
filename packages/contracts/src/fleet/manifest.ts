import { z } from 'zod';
import { TopicNameSchema } from '../protocol/event.ts';
import { CommandNameSchema, NodeIdSchema } from '../protocol/identity.ts';
import { MAX_NODES, MAX_TOPIC_RETAINED_BYTES } from '../protocol/bounds.ts';
import {
  MAX_DECLARED_TOPICS,
  namespacesOverlap,
  TopicDeclarationSchema,
  TopicNamespaceSchema,
} from '../protocol/topic.ts';
import { ServiceIdSchema, ServiceOperationIdSchema } from '../service/contracts.ts';
import { ServiceNamespaceSchema } from '../service/declaration.ts';

/**
 * The fleet's own declaration of authority: who belongs to the fleet, and what each pair of nodes
 * may do to each other.
 *
 * A permission is a fact about a PAIR: this node may do that to that node. Deployed, it is stored
 * several times over — capabilities, command grants, service grants and topics at each broker, the
 * matching halves at each node — and every copy edited by hand drifts. So the manifest is written
 * the way a reader asks the question, one entry per pair, and every deployed table is projected from
 * it (`runtime/src/fleet/projection.ts`). What is not declared here does not appear there.
 *
 * Namespaces are where the manifest deliberately says less: it grants a node a prefix, and the
 * owners of that node's applications declare the topics and services inside it themselves.
 */

export const FLEET_MANIFEST_VERSION = 1;

const TargetSchema = z.union([NodeIdSchema, z.literal('*')]);
/** `service-read` admits every reading operation of a service; anything else names one operation. */
const ScopeSchema = z.union([z.literal('service-read'), ServiceOperationIdSchema]);

/**
 * A fleet topic: its producer, its readers and its profile. The profile is carried to the brokers
 * exactly as written, so it is checked here against the broker's own schema rather than reshaped.
 */
const FleetTopicSchema = z
  .looseObject({ producer: NodeIdSchema, subscribers: z.array(NodeIdSchema).min(1) })
  .superRefine((topic, ctx) => {
    const parsed = TopicDeclarationSchema.safeParse(topic);
    if (!parsed.success)
      for (const issue of parsed.error.issues)
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
  });

/** What a topic namespace grants, whoever produces in it. */
export const FleetTopicGrantSchema = z.strictObject({
  subscribers: z.array(NodeIdSchema).min(1).max(256),
  maxTopics: z.number().int().min(1).max(MAX_DECLARED_TOPICS),
  maxRetainedBytes: z.number().int().min(0).max(MAX_TOPIC_RETAINED_BYTES).optional(),
});
export const FleetTopicNamespaceSchema = z.strictObject({
  producer: NodeIdSchema,
  ...FleetTopicGrantSchema.shape,
});

const FleetAccessSchema = z
  .strictObject({
    from: NodeIdSchema,
    to: TargetSchema,
    services: z.record(ServiceIdSchema, z.array(ScopeSchema).min(1)).optional(),
    commands: z.array(CommandNameSchema).min(1).optional(),
    peer: z.literal(true).optional(),
    stream: z.literal(true).optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.to === '*' && Object.keys(entry.services ?? {}).length > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'service grants require a concrete target node',
      });
  });

/**
 * How much of the fleet a member keeps. `full` holds the whole signed bundle and can hand it to any
 * broker that lost it; `own` holds only its own signed part and never learns about the rest of the
 * fleet — the right shape for a machine the fleet does not fully trust.
 */
export const FleetCopySchema = z.enum(['full', 'own']);

export const FleetMemberSchema = z.strictObject({ copy: FleetCopySchema });

export const FleetManifestSchema = z
  .strictObject({
    version: z.literal(FLEET_MANIFEST_VERSION),
    // A fleet is bounded by the roster a broker accepts (`MAX_NODES`): a manifest naming more could
    // be signed and published but never projected into a broker configuration.
    members: z
      .record(NodeIdSchema, FleetMemberSchema)
      .refine((members) => Object.keys(members).length <= MAX_NODES, {
        message: `a fleet names at most ${MAX_NODES} nodes`,
      }),
    access: z.array(FleetAccessSchema).max(1024),
    topics: z.record(TopicNameSchema, FleetTopicSchema).default({}),
    topicNamespaces: z.record(TopicNamespaceSchema, FleetTopicNamespaceSchema).default({}),
    serviceNamespaces: z.record(NodeIdSchema, z.array(ServiceNamespaceSchema).min(1).max(16)).default({}),
  })
  .superRefine((manifest, ctx) => {
    const members = new Set(Object.keys(manifest.members));
    if (members.size === 0)
      ctx.addIssue({ code: 'custom', path: ['members'], message: 'a fleet has members' });
    // A node named anywhere but not a member would receive nothing: its grants would read as
    // authority and reach no machine. The line that names it is the one to fix.
    const member = (node: string, path: Array<string | number>): void => {
      if (!members.has(node)) ctx.addIssue({ code: 'custom', path, message: `'${node}' is not a member` });
    };
    const seen = new Set<string>();
    for (const [index, entry] of manifest.access.entries()) {
      member(entry.from, ['access', index, 'from']);
      if (entry.to !== '*') member(entry.to, ['access', index, 'to']);
      const key = `${entry.from} ${entry.to}`;
      if (seen.has(key))
        ctx.addIssue({ code: 'custom', path: ['access', index], message: 'duplicate access pair' });
      seen.add(key);
      for (const [service, scopes] of Object.entries(entry.services ?? {}))
        if (new Set(scopes).size !== scopes.length)
          ctx.addIssue({
            code: 'custom',
            path: ['access', index, 'services', service],
            message: 'duplicate scope',
          });
      if (entry.commands && new Set(entry.commands).size !== entry.commands.length)
        ctx.addIssue({ code: 'custom', path: ['access', index, 'commands'], message: 'duplicate command' });
      // A pair that grants nothing is a line that reads as authority and carries none.
      if (!entry.services && !entry.commands && !entry.peer && !entry.stream)
        ctx.addIssue({ code: 'custom', path: ['access', index], message: 'access entry grants nothing' });
    }
    for (const [topic, declaration] of Object.entries(manifest.topics)) {
      member(declaration.producer, ['topics', topic, 'producer']);
      for (const subscriber of declaration.subscribers) member(subscriber, ['topics', topic, 'subscribers']);
    }
    const prefixes = Object.keys(manifest.topicNamespaces);
    for (const [index, prefix] of prefixes.entries()) {
      const grant = manifest.topicNamespaces[prefix];
      if (grant === undefined) continue;
      member(grant.producer, ['topicNamespaces', prefix, 'producer']);
      for (const subscriber of grant.subscribers)
        member(subscriber, ['topicNamespaces', prefix, 'subscribers']);
      if (new Set(grant.subscribers).size !== grant.subscribers.length)
        ctx.addIssue({ code: 'custom', path: ['topicNamespaces', prefix], message: 'duplicate subscriber' });
      // The broker refuses overlap too; refusing it here names the manifest line, not a broker boot.
      for (const other of prefixes.slice(index + 1))
        if (namespacesOverlap(prefix, other))
          ctx.addIssue({ code: 'custom', path: ['topicNamespaces', prefix], message: `overlaps '${other}'` });
    }
    for (const [node, granted] of Object.entries(manifest.serviceNamespaces)) {
      member(node, ['serviceNamespaces', node]);
      if (new Set(granted).size !== granted.length)
        ctx.addIssue({
          code: 'custom',
          path: ['serviceNamespaces', node],
          message: 'duplicate service namespace',
        });
    }
  });
export type FleetManifest = z.output<typeof FleetManifestSchema>;
