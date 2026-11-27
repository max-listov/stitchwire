import { z } from 'zod';
import { MAX_NODES } from '../protocol/bounds.ts';
import { NodeIdSchema } from '../protocol/identity.ts';
import { TopicNameSchema } from '../protocol/event.ts';
import { EventDeclareRefusalSchema, TopicNamespaceSchema } from '../protocol/topic.ts';
import { ServiceDeclareRefusalSchema, ServiceNamespaceSchema } from '../service/declaration.ts';
import { PresenceSchema } from '../protocol/presence.ts';
import { ReleaseStandingSchema } from '../protocol/release.ts';
import { LocalVersionSchema } from './common.ts';
import { FleetNodeStatusSchema } from '../fleet/status.ts';

const ByteCountSchema = z.number().int().nonnegative();
export const JournalAnomalySchema = z
  .object({
    file: z.string(),
    offset: ByteCountSchema,
    line: z.number().int().positive(),
    reason: z.enum([
      'nul-byte',
      'unterminated-line',
      'invalid-utf8',
      'invalid-json',
      'invalid-frame',
      'invalid-event',
      'oversized-line',
    ]),
    position: z.enum(['tail', 'interior']),
    terminated: z.boolean(),
    skippedBytes: ByteCountSchema,
  })
  .strict();

/** A file the journal set aside at startup instead of refusing to start; it is never deleted. */
export const QuarantinedFileSchema = z
  .object({
    file: z.string(),
    quarantinedAs: z.string(),
    reason: z.enum(['not-a-regular-file', 'torn-without-retention-slot', 'unreadable']).optional(),
    code: z.string().optional(),
  })
  .strict();

/**
 * What journal recovery found at startup, as this door reports it.
 *
 * The journal's framework reports the same facts in its own schema. The door states its own form
 * instead of importing that one: a field the framework adds or renames would otherwise change this
 * protocol without a version change. The recovery tests parse the framework's real report with this
 * schema, so a framework change fails a test here rather than reaching a client.
 */
export const JournalRecoverySchema = z
  .object({
    filesChecked: ByteCountSchema,
    anomalies: ByteCountSchema,
    skippedBytes: ByteCountSchema,
    firstAnomaly: JournalAnomalySchema.optional(),
    lastAnomaly: JournalAnomalySchema.optional(),
    quarantined: z.array(QuarantinedFileSchema).readonly().optional(),
    quarantinedUnlisted: ByteCountSchema.optional(),
  })
  .strict();

export const AuditJournalSchema = z
  .object({
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    generations: z.number().int().nonnegative(),
    maxBytes: z.number().int().positive(),
    keep: z.number().int().nonnegative(),
    rotations: z.number().int().nonnegative(),
  })
  .strict();

export const AuditStatusSchema = z
  .object({
    queued: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
    writeFailures: z.number().int().nonnegative(),
    lastFailure: z.string().nullable(),
    recovery: JournalRecoverySchema.optional(),
    journal: AuditJournalSchema,
  })
  .strict();

export type AuditStatus = z.infer<typeof AuditStatusSchema>;

/** Last observed lane failure; `refused` distinguishes a rejected handshake from a failed dial or lost
 *  connection. It does not predict whether recovery is possible. Refusals re-dial with bounded
 *  backoff, and a successful connection clears this record. */
export const LaneFailureSchema = z
  .object({ at: z.string(), reason: z.string(), refused: z.boolean() })
  .strict();

export const LaneEventSubscriptionsSchema = z
  .object({ observedAt: z.iso.datetime(), activeSubscriptions: z.number().int().nonnegative() })
  .strict();

export const LaneStatusSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    connected: z.boolean(),
    eventSubscriptions: LaneEventSubscriptionsSchema,
    serves: z.boolean(),
    nodesVisible: z.number().int().min(0),
    presence: z.enum(['ready', 'pending', 'unavailable', 'disconnected']),
    lastFailure: LaneFailureSchema.nullable(),
  })
  .strict();

/** An allowed command together with whether its binary exists. A name alone is not enough: a doctor
 *  that lists a command and says nothing about the file being absent lies exactly as a check does
 *  that exits successfully when its tool is missing. */
export const AllowedCommandStatusSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    present: z.boolean(),
    cwd: z.string().nullable(),
    cwdPresent: z.boolean(),
    callerArgs: z.enum(['none', 'append', 'options']),
    stdin: z.enum(['none', 'text']),
    timeoutMs: z.number().int(),
    outputBytes: z.number().int(),
    concurrency: z.number().int(),
  })
  .strict();

export const StreamProfileStatusSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    present: z.boolean(),
    cwd: z.string().nullable(),
    cwdPresent: z.boolean(),
    format: z.enum(['raw', 'ndjson']),
    stableCursor: z.boolean(),
    timeoutMs: z.number().int(),
    maxBytes: z.number().int(),
    concurrency: z.number().int(),
  })
  .strict();

const DescriptorStateSchema = z.enum(['loaded', 'missing', 'invalid']);

export const TopicDescriptorReadingSchema = z
  .object({
    path: z.string(),
    state: DescriptorStateSchema,
    topics: z.number().int().min(0),
    detail: z.string().nullable(),
  })
  .strict();

export const TopicLaneDeclarationSchema = z
  .object({
    lane: z.string(),
    declaredAt: z.iso.datetime(),
    accepted: z.number().int().min(0),
    refused: z.array(EventDeclareRefusalSchema),
  })
  .strict();

/**
 * The topics this node's owners declare, as read here and as each broker answered. Empty when no
 * descriptor is bound. An owner reads why a topic is missing on their own machine instead of in a
 * broker's journal.
 */
export const TopicDeclarationsStatusSchema = z
  .object({
    descriptors: z.array(TopicDescriptorReadingSchema),
    refused: z.array(EventDeclareRefusalSchema),
    lanes: z.array(TopicLaneDeclarationSchema),
  })
  .strict();

export const EventNamespacesStatusSchema = z
  .object({ publish: z.array(TopicNamespaceSchema), subscribe: z.array(TopicNamespaceSchema) })
  .strict();

export const EventSubscriptionStatusSchema = z
  .object({ subscriptionId: z.uuid(), topic: TopicNameSchema })
  .strict();

export const EventTopicSubscriptionsSchema = z
  .object({ topic: TopicNameSchema, activeSubscriptions: z.number().int().positive() })
  .strict();

export const EventsStatusSchema = z
  .object({
    publish: z.array(TopicNameSchema),
    subscribe: z.array(TopicNameSchema),
    namespaces: EventNamespacesStatusSchema,
    declarations: TopicDeclarationsStatusSchema,
    activeSubscriptions: z.number().int().min(0),
    observedAt: z.iso.datetime(),
    subscriptions: z.array(EventSubscriptionStatusSchema),
    topics: z.array(EventTopicSubscriptionsSchema),
    pendingPublishes: z.number().int().min(0),
  })
  .strict();

export const ServiceDescriptorReadingSchema = z
  .object({
    path: z.string(),
    state: DescriptorStateSchema,
    service: z.string().nullable(),
    callers: z.number().int().min(0),
    detail: z.string().nullable(),
  })
  .strict();

export const ServiceLocalRefusalSchema = z
  .object({ path: z.string(), service: z.string(), detail: z.string() })
  .strict();

export const ServiceLaneDeclarationSchema = z
  .object({
    lane: z.string(),
    declaredAt: z.iso.datetime(),
    accepted: z.number().int().min(0),
    refused: z.array(ServiceDeclareRefusalSchema),
  })
  .strict();

export const ServiceDeclarationsStatusSchema = z
  .object({
    descriptors: z.array(ServiceDescriptorReadingSchema),
    refused: z.array(ServiceLocalRefusalSchema),
    lanes: z.array(ServiceLaneDeclarationSchema),
  })
  .strict();

/**
 * The services this node's owners declare: the namespaces the fleet granted, each bound declaration
 * as read here, and each broker's answer about who may call. Empty when no declaration is bound.
 */
export const ServicesStatusSchema = z
  .object({ namespaces: z.array(ServiceNamespaceSchema), declarations: ServiceDeclarationsStatusSchema })
  .strict();

/**
 * The node-wide ceilings a caller can actually hit, published so a client can pace itself instead of
 * discovering each one by being refused. Per-command and per-profile concurrency live in `allow[]`
 * and `streams[]` — this is what is shared across all of them.
 *
 * The local door is an exact contract. A mixed revision is rejected instead of being rendered as a
 * partial status whose missing limits look like unknown runtime health.
 */
export const AdmissionStatusSchema = z
  .object({
    maxInflight: z.number().int().min(0),
    maxCallsPerMinute: z.number().int().min(0),
    maxStreamProducers: z.number().int().min(0),
    maxStreamConsumers: z.number().int().min(0),
    maxStreamBufferedBytes: z.number().int().min(0),
    maxEventSubscriptions: z.number().int().min(0),
    maxPendingPublishes: z.number().int().min(0),
    maxPublishesPerMinute: z.number().int().min(0),
  })
  .strict();

/**
 * The file this agent actually loaded, and its mode.
 *
 * A node whose service still runs yesterday's file looks perfectly healthy from the outside:
 * `doctor` renders whatever the agent has in memory and cannot tell that the config on disk is a
 * different one. Reporting the origin is what turns "the config says X" into "the RUNNING agent
 * read X, from here".
 */
export const ConfigOriginSchema = z.object({ path: z.string(), mode: z.string().nullable() }).strict();

export const ApplicationResourcesSchema = z
  .object({
    total: z.number().int().min(0),
    ready: z.number().int().min(0),
    degraded: z.number().int().min(0),
    failed: z.number().int().min(0),
  })
  .strict();

/**
 * The lifecycle kernel's own verdict about this process, beside the domain rather than mixed into it.
 *
 * `ready` and `health` are different questions and this is where they stop sharing an answer: a node
 * whose every lane is down is READY — its door answers, which is the whole point of a machine that
 * reports its situation instead of hanging — and it is not HEALTHY. The application projection is
 * part of the status contract, not an additive hint.
 */
export const ApplicationStatusSchema = z
  .object({
    id: z.string(),
    lifecycle: z.string(),
    health: z.string(),
    ready: z.boolean(),
    capturedAt: z.string(),
    resources: ApplicationResourcesSchema,
  })
  .strict();
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const LocalStatusSchema = z
  .object({
    v: LocalVersionSchema,
    nodeId: NodeIdSchema,
    connected: z.boolean(),
    lanes: z.array(LaneStatusSchema),
    serves: z.boolean(),
    version: z.string(),
    publicationAudit: AuditStatusSchema,
    serviceAudit: AuditStatusSchema.optional(),
    allow: z.array(AllowedCommandStatusSchema),
    streams: z.array(StreamProfileStatusSchema),
    events: EventsStatusSchema,
    services: ServicesStatusSchema,
    /**
     * The fleet bundle this node keeps, whether the configuration it runs matches it, and which
     * edition each broker lane answered with. `config: unconfigured` when no fleet trust is set.
     */
    bundle: FleetNodeStatusSchema,
    admission: AdmissionStatusSchema,
    config: ConfigOriginSchema.nullable(),
    /**
     * Which build this node carries, and whether anything has confirmed what the fleet runs.
     *
     * The same shape the other fleet daemon publishes, so a reader learns one form rather than two
     * that nearly agree. `latest` is what this node CONFIRMED, never what it assumes: a node that
     * reached no broker says `null` and is drawn as unknown rather than as current, which is the
     * whole point — the reassuring reading is the expensive one. A revision mismatch is explicit;
     * this block is never silently absent.
     */
    release: ReleaseStandingSchema,
    application: ApplicationStatusSchema,
    nodes: z.array(PresenceSchema).max(MAX_NODES),
  })
  .strict();
export type LocalStatus = z.infer<typeof LocalStatusSchema>;
