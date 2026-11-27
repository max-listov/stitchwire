/** The broker configuration: nodes, grants, topics, namespaces and admission. */

import { z } from 'zod';
import { FleetTrustSchema } from '../../../contracts/src/fleet/bundle.ts';
import {
  MAX_AUDIT_FILE_BYTES,
  MAX_AUDIT_GENERATIONS,
  MAX_FRAME_BYTES,
  MAX_NODES,
  MAX_RETAINED_BYTES_TOTAL,
  MAX_STREAM_CHUNK_BYTES,
  MAX_STREAM_TOTAL_BYTES,
  MAX_STREAM_WINDOW_BYTES,
  MAX_TOPIC_RETAINED_BYTES,
} from '../../../contracts/src/protocol/bounds.ts';
import { TopicNameSchema } from '../../../contracts/src/protocol/event.ts';
import { CommandNameSchema, NodeIdSchema } from '../../../contracts/src/protocol/identity.ts';
import {
  isTopicInNamespace,
  MAX_DECLARED_TOPICS,
  namespacesOverlap,
  TopicDeclarationSchema,
  TopicNamespaceSchema,
} from '../../../contracts/src/protocol/topic.ts';
import { ServiceNamespaceSchema } from '../../../contracts/src/service/declaration.ts';
import { ServiceGrantsSchema } from '../../../contracts/src/service/policy-schema.ts';

import { paths } from './paths.ts';

const BrokerNodeSchema = z
  .object({
    id: NodeIdSchema,
    /** At most two active digests permit a bounded overlap while a token is rotated. */
    tokenSha256s: z
      .array(z.string().regex(/^[0-9a-f]{64}$/))
      .min(1)
      .max(2),
    note: z.string().default(''),
  })
  .strict();

/**
 * What a broker grant can authorise. `peer` is the observation half (round-trip time to a node);
 * command execution is granted per command in `commandGrants` below, because a grant that cannot
 * name the operation cannot be read as authorising one.
 */
const CapabilityOperationSchema = z.enum(['peer', 'stream', 'publish', 'subscribe']);
export type CapabilityOperation = z.infer<typeof CapabilityOperationSchema>;

const CapabilityGrantSchema = z
  .object({
    operation: CapabilityOperationSchema,
    targets: z
      .array(z.union([NodeIdSchema, z.literal('*')]))
      .min(1)
      .max(128),
  })
  .strict();

/**
 * Who may run WHICH declared command on which node.
 *
 * The command is part of the grant, not a detail the node discovers afterwards. A wildcard exists
 * for targets, deliberately, because a fleet's node list changes and a command's meaning does not —
 * but there is no wildcard for the command itself: `command: '*'` would be exactly a
 * blanket permission, and a table that can say "anything" is a table nobody reads.
 */
export const CommandGrantSchema = z
  .object({
    caller: NodeIdSchema,
    targets: z
      .array(z.union([NodeIdSchema, z.literal('*')]))
      .min(1)
      .max(128),
    command: CommandNameSchema,
  })
  .strict();

/**
 * A namespace the fleet grants to one producer: that producer may declare topics inside it, and the
 * named nodes may read them. The grant carries what the fleet decides — who sends to whom, how many
 * topics fit, how much retained memory they may cost this broker. The names and profiles inside it
 * belong to the owner of the producing application, who declares them without asking anyone.
 */
const TopicNamespaceGrantSchema = z
  .object({
    producer: NodeIdSchema,
    subscribers: z.array(NodeIdSchema).min(1).max(256),
    maxTopics: z.number().int().min(1).max(MAX_DECLARED_TOPICS),
    maxRetainedBytes: z.number().int().min(0).max(MAX_TOPIC_RETAINED_BYTES).default(0),
  })
  .strict()
  .superRefine((grant, ctx) => {
    if (new Set(grant.subscribers).size !== grant.subscribers.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['subscribers'],
        message: 'namespace subscribers must be unique',
      });
    }
  });
export type TopicNamespaceGrant = z.infer<typeof TopicNamespaceGrantSchema>;

/**
 * How large the journal may get before it is rolled over, and how many rolled generations survive.
 *
 * By size and not by age. A quiet broker with a small journal is not a problem anybody has, so an
 * age bound would defend something that does not hurt and cost a second knob and a timer; size
 * answers the failure that actually happened — an append-only file with no end, on a disk with one.
 *
 * The defaults keep at most 512 MiB. Measured against the fleet that motivated this (~423 MB a day
 * through the busiest broker) that is about a day of history: the alternative that keeps a quarter
 * of a gigabyte buys under fourteen hours, and a journal that has forgotten last evening by morning
 * has forgotten the thing people open it for.
 */
export const AuditRotationSchema = z
  .object({
    /** The active file never exceeds this: the switch happens BEFORE the line that would. */
    maxBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(MAX_AUDIT_FILE_BYTES)
      .default(64 * 1024 * 1024),
    /** Rolled generations kept beside the active file. At least one: after a crash the torn active
     *  file is moved aside into a generation before writing resumes, and with nowhere to move it
     *  the journal refuses to open — a broker that cannot start is worse than one rolled file. */
    keep: z.number().int().min(1).max(MAX_AUDIT_GENERATIONS).default(7),
  })
  .strict()
  .prefault({});
export type AuditRotation = z.infer<typeof AuditRotationSchema>;

const BrokerAdmissionSchema = z
  .object({
    maxInflightPerNode: z.number().int().min(1).max(1_024).default(32),
    maxCallsPerMinutePerNode: z.number().int().min(1).max(60_000).default(600),
    maxFrameBytes: z
      .number()
      .int()
      .min(64 * 1024)
      .max(MAX_FRAME_BYTES)
      .default(MAX_FRAME_BYTES),
    maxStreamsTotal: z.number().int().min(1).max(4_096).default(128),
    maxStreamsPerCaller: z.number().int().min(1).max(1_024).default(8),
    maxStreamsPerProducer: z.number().int().min(1).max(1_024).default(16),
    maxStreamOpensPerMinute: z.number().int().min(1).max(60_000).default(120),
    maxStreamChunkBytes: z
      .number()
      .int()
      .min(1_024)
      .max(MAX_STREAM_CHUNK_BYTES)
      .default(32 * 1024),
    maxStreamWindowBytes: z
      .number()
      .int()
      .min(1_024)
      .max(MAX_STREAM_WINDOW_BYTES)
      .default(256 * 1024),
    maxStreamBytes: z
      .number()
      .int()
      .min(1_024)
      .max(MAX_STREAM_TOTAL_BYTES)
      .default(64 * 1024 * 1024),
    streamSlowConsumerTimeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
    maxTopics: z.number().int().min(1).max(4_096).default(256),
    maxEventSubscriptionsTotal: z.number().int().min(1).max(65_536).default(1_024),
    /** How often one node may OPEN a subscription, as opposed to how many it may hold. Sized
     *  against measured fleet behaviour — a live node sits near 180/min — so the ceiling bounds a
     *  runaway without refusing anything real on the day it ships. */
    maxEventSubscribesPerMinute: z.number().int().min(1).max(60_000).default(600),
    /** The ceiling on every topic ring added together — the one place that answers "how much memory
     *  can retention cost this broker" without reading every topic. */
    maxRetainedBytesTotal: z
      .number()
      .int()
      .min(0)
      .max(MAX_RETAINED_BYTES_TOTAL)
      .default(64 * 1024 * 1024),
  })
  .strict()
  .prefault({});

/**
 * Where this broker takes its fleet tables from, when it takes them from a signed fleet bundle.
 *
 * Present, the broker keeps the newest bundle signed by one of these keys, hands each connecting
 * node the part it may hold, and projects `capabilities`, `commandGrants`, `serviceGrants`, `topics`,
 * `topicNamespaces` and `serviceNamespaces` from it for the nodes on its own roster. The roster,
 * credentials, admission and audit stay this machine's.
 */
const BrokerFleetSchema = z.strictObject({
  trust: FleetTrustSchema,
  copy: z.string().min(1).max(1024).default(paths.brokerFleetCopy),
  pollMs: z.number().int().min(200).max(300_000).default(5_000),
});
export type BrokerFleet = z.infer<typeof BrokerFleetSchema>;

export const BrokerConfigSchema = z
  .object({
    fleet: BrokerFleetSchema.optional(),
    /** Loopback by default. TLS and the public edge belong to the reverse proxy in front, which
     *  already renews certificates for everything else on that box. */
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65_535).default(8790),
    nodes: z.array(BrokerNodeSchema).min(1).max(MAX_NODES),
    /**
     * Who may do what to whom, per operation. Absent key = that node may do nothing.
     *
     * Default-deny is the whole point. A broker reachable from the internet with an open policy
     * would turn one stolen token into remote execution on every machine at once. `rpc`, `stream`,
     * `publish` and `subscribe` grant no authority to one another.
     */
    capabilities: z.record(NodeIdSchema, z.array(CapabilityGrantSchema).max(32)).default({}),
    commandGrants: z.array(CommandGrantSchema).max(512).default([]),
    serviceGrants: ServiceGrantsSchema.default([]),
    /**
     * Service-name prefixes each node may serve and grant callers for itself. A node declares the
     * grants for its owners' services inside these; see `ServiceGrantRegistry`.
     */
    serviceNamespaces: z.record(NodeIdSchema, z.array(ServiceNamespaceSchema).max(16)).default({}),
    topics: z.record(TopicNameSchema, TopicDeclarationSchema).default({}),
    /** Namespaces whose topics their producer declares itself. See `TopicNamespaceGrantSchema`. */
    topicNamespaces: z.record(TopicNamespaceSchema, TopicNamespaceGrantSchema).default({}),
    admission: BrokerAdmissionSchema,
    /** Every admission decision and every dispatch, append-only. Not optional: a channel that can
     *  run commands on other machines and keeps no record is not one you can reason about later. */
    auditPath: z.string().default(paths.audit),
    auditQueueLimit: z.number().int().min(1).max(65_536).default(4_096),
    auditRotate: AuditRotationSchema,
  })
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set(config.nodes.map((node) => node.id));
    if (ids.size !== config.nodes.length) {
      ctx.addIssue({ code: 'custom', path: ['nodes'], message: 'node ids must be unique' });
    }
    const validatePolicy = (source: string, targets: string[], path: Array<string | number>): void => {
      if (!ids.has(source)) {
        ctx.addIssue({ code: 'custom', path, message: `policy source '${source}' is not registered` });
      }
      for (const target of targets) {
        if (target !== '*' && !ids.has(target)) {
          ctx.addIssue({ code: 'custom', path, message: `policy target '${target}' is not registered` });
        }
      }
    };
    for (const [source, grants] of Object.entries(config.capabilities)) {
      for (const [index, grant] of grants.entries()) {
        validatePolicy(source, grant.targets, ['capabilities', source, index, 'targets']);
      }
    }
    const namespaces = Object.entries(config.topicNamespaces);
    // The budget is what the broker must be ready to hold, not what happens to be declared today:
    // every namespace counts at its ceiling, so no owner's declaration can outgrow the process.
    const topicBudget =
      Object.keys(config.topics).length + namespaces.reduce((total, [, grant]) => total + grant.maxTopics, 0);
    if (topicBudget > config.admission.maxTopics) {
      ctx.addIssue({
        code: 'custom',
        path: ['topics'],
        message: `topic count exceeds broker admission limit (${topicBudget} counting every namespace at its ceiling, limit ${config.admission.maxTopics})`,
      });
    }
    const retainedTotal =
      Object.values(config.topics).reduce((total, topic) => total + topic.retain.maxBytes, 0) +
      namespaces.reduce((total, [, grant]) => total + grant.maxRetainedBytes, 0);
    if (retainedTotal > config.admission.maxRetainedBytesTotal) {
      ctx.addIssue({
        code: 'custom',
        path: ['topics'],
        message: `topic retention sums to ${retainedTotal} bytes, above the broker limit of ${config.admission.maxRetainedBytesTotal}`,
      });
    }
    for (const [name, topic] of Object.entries(config.topics)) {
      if (!ids.has(topic.producer)) {
        ctx.addIssue({
          code: 'custom',
          path: ['topics', name, 'producer'],
          message: 'producer is not registered',
        });
      }
      for (const [index, subscriber] of topic.subscribers.entries()) {
        if (!ids.has(subscriber)) {
          ctx.addIssue({
            code: 'custom',
            path: ['topics', name, 'subscribers', index],
            message: 'subscriber is not registered',
          });
        }
      }
      // A fleet topic inside another producer's namespace would give one name two producers.
      for (const [prefix, grant] of namespaces)
        if (isTopicInNamespace(prefix, name) && grant.producer !== topic.producer)
          ctx.addIssue({
            code: 'custom',
            path: ['topics', name],
            message: `topic lies inside namespace '${prefix}', which is granted to ${grant.producer}`,
          });
    }
    for (const [index, [prefix, grant]] of namespaces.entries()) {
      if (!ids.has(grant.producer))
        ctx.addIssue({
          code: 'custom',
          path: ['topicNamespaces', prefix, 'producer'],
          message: 'producer is not registered',
        });
      for (const subscriber of grant.subscribers)
        if (!ids.has(subscriber))
          ctx.addIssue({
            code: 'custom',
            path: ['topicNamespaces', prefix, 'subscribers'],
            message: `subscriber '${subscriber}' is not registered`,
          });
      // Overlap is refused outright rather than resolved by precedence: with two namespaces able
      // to hold one name, which producer owns it would depend on which declared first.
      for (const [other] of namespaces.slice(index + 1))
        if (namespacesOverlap(prefix, other))
          ctx.addIssue({
            code: 'custom',
            path: ['topicNamespaces', prefix],
            message: `namespace overlaps '${other}': one name could belong to both`,
          });
    }
    // Service namespaces may repeat across nodes: one owner runs the same service on many machines,
    // and each node grants calls only to itself, so two nodes never contend for one grant.
    for (const [node, prefixes] of Object.entries(config.serviceNamespaces)) {
      if (!ids.has(node))
        ctx.addIssue({
          code: 'custom',
          path: ['serviceNamespaces', node],
          message: 'node is not registered',
        });
      if (new Set(prefixes).size !== prefixes.length)
        ctx.addIssue({
          code: 'custom',
          path: ['serviceNamespaces', node],
          message: 'service namespaces must be unique',
        });
    }
  })
  .transform(({ capabilities, ...config }) => ({ ...config, capabilities }));
export type BrokerConfig = z.infer<typeof BrokerConfigSchema>;
