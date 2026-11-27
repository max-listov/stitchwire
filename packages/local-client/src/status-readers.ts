/**
 * Forward-compatible readers of the local door's `/status` and a broker's `/health`.
 *
 * A fleet runs more than one release, so a reader meets answers written by a newer one. It ignores a
 * field it does not know, it takes a value of an enumerated field it does not know as `unrecognized`,
 * and it does not count rows: the response body is bounded by bytes. The writers stay strict — these
 * schemas are built beside them and never change them. Browser-safe: `zod` and pure contracts only.
 */
import { z } from 'zod';
import * as doorStatus from '../../contracts/src/door/status.ts';
import * as fleetStatus from '../../contracts/src/fleet/status.ts';
import {
  BrokerHealthContractSchema,
  EventLoopDelaySnapshotSchema,
  TransportObservationSnapshotSchema,
} from '../../contracts/src/protocol/broker-health.ts';
import {
  DepartureKindSchema,
  DepartureSchema,
  PresenceSchema,
} from '../../contracts/src/protocol/presence.ts';
import { BehindBySchema, ReleaseStandingSchema } from '../../contracts/src/protocol/release.ts';
import { EventDeclareRefusalSchema } from '../../contracts/src/protocol/topic.ts';
import { ServiceDeclareRefusalSchema } from '../../contracts/src/service/declaration.ts';

/**
 * What a reader makes of an enumerated value its release does not know. It is not `unknown`, which
 * writers already send to say they do not know something; a decision that meets `unrecognized`
 * treats it as unknown or failed, never as fine.
 */
type Unrecognized = 'unrecognized';
const unrecognized = (): Unrecognized => 'unrecognized';

/** A writer's enum as a reader takes it: one of its values, or `unrecognized` for any other string. */
function knownOrUnrecognized<T extends Readonly<Record<string, string>>>(known: z.ZodEnum<T>) {
  return z.union([known, z.string().transform(unrecognized)]);
}

const BehindByReaderSchema = knownOrUnrecognized(BehindBySchema.unwrap()).nullable();

const PresenceReaderSchema = PresenceSchema.extend({
  behind: BehindByReaderSchema,
  departure: DepartureSchema.extend({ kind: knownOrUnrecognized(DepartureKindSchema) })
    .strip()
    .nullable(),
}).strip();

const ApplicationStatusReaderSchema = doorStatus.ApplicationStatusSchema.extend({
  resources: doorStatus.ApplicationResourcesSchema.strip(),
}).strip();

const anomaly = doorStatus.JournalAnomalySchema.shape;
const JournalAnomalyReaderSchema = doorStatus.JournalAnomalySchema.extend({
  reason: knownOrUnrecognized(anomaly.reason),
  position: knownOrUnrecognized(anomaly.position),
}).strip();

/** Forward-compatible reader for audit journal status. */
export const AuditStatusSchema = doorStatus.AuditStatusSchema.extend({
  recovery: doorStatus.JournalRecoverySchema.extend({
    firstAnomaly: JournalAnomalyReaderSchema.optional(),
    lastAnomaly: JournalAnomalyReaderSchema.optional(),
    quarantined: z
      .array(
        doorStatus.QuarantinedFileSchema.extend({
          reason: knownOrUnrecognized(doorStatus.QuarantinedFileSchema.shape.reason.unwrap()).optional(),
        }).strip(),
      )
      .readonly()
      .optional(),
  })
    .strip()
    .optional(),
  journal: doorStatus.AuditJournalSchema.strip(),
}).strip();
export type AuditStatus = z.output<typeof AuditStatusSchema>;

/** Forward-compatible reader for one broker lane status. */
export const LaneStatusSchema = doorStatus.LaneStatusSchema.extend({
  eventSubscriptions: doorStatus.LaneEventSubscriptionsSchema.strip(),
  presence: knownOrUnrecognized(doorStatus.LaneStatusSchema.shape.presence),
  lastFailure: doorStatus.LaneFailureSchema.strip().nullable(),
}).strip();
export type LaneStatus = z.output<typeof LaneStatusSchema>;

/** Whether a configuration matches its kept edition, as a reader takes it. */
export const FleetConfigStateSchema = knownOrUnrecognized(fleetStatus.FleetConfigStateSchema);
export type FleetConfigState = z.output<typeof FleetConfigStateSchema>;

/** Forward-compatible reader for a broker's fleet bundle edition status. */
export const FleetEditionStatusSchema = fleetStatus.FleetEditionStatusSchema.extend({
  config: FleetConfigStateSchema,
}).strip();
export type FleetEditionStatus = z.output<typeof FleetEditionStatusSchema>;

/** Forward-compatible reader for a node's fleet bundle status including per-lane sync states. */
export const FleetNodeStatusSchema = fleetStatus.FleetNodeStatusSchema.extend({
  config: FleetConfigStateSchema,
  copy: knownOrUnrecognized(fleetStatus.FleetNodeStatusSchema.shape.copy),
  lanes: z.array(fleetStatus.FleetNodeStatusSchema.shape.lanes.element.strip()),
}).strip();
export type FleetNodeStatus = z.output<typeof FleetNodeStatusSchema>;

const descriptorState = knownOrUnrecognized(doorStatus.TopicDescriptorReadingSchema.shape.state);
const refusedTopics = z.array(EventDeclareRefusalSchema.strip());
const command = doorStatus.AllowedCommandStatusSchema.shape;

/** Forward-compatible reader for the local door `/status` response. */
export const StatusResultSchema = doorStatus.LocalStatusSchema.extend({
  lanes: z.array(LaneStatusSchema),
  publicationAudit: AuditStatusSchema,
  serviceAudit: AuditStatusSchema.optional(),
  allow: z.array(
    doorStatus.AllowedCommandStatusSchema.extend({
      callerArgs: knownOrUnrecognized(command.callerArgs),
      stdin: knownOrUnrecognized(command.stdin),
    }).strip(),
  ),
  streams: z.array(
    doorStatus.StreamProfileStatusSchema.extend({
      format: knownOrUnrecognized(doorStatus.StreamProfileStatusSchema.shape.format),
    }).strip(),
  ),
  events: doorStatus.EventsStatusSchema.extend({
    namespaces: doorStatus.EventNamespacesStatusSchema.strip(),
    declarations: doorStatus.TopicDeclarationsStatusSchema.extend({
      descriptors: z.array(
        doorStatus.TopicDescriptorReadingSchema.extend({ state: descriptorState }).strip(),
      ),
      refused: refusedTopics,
      lanes: z.array(doorStatus.TopicLaneDeclarationSchema.extend({ refused: refusedTopics }).strip()),
    }).strip(),
    subscriptions: z.array(doorStatus.EventSubscriptionStatusSchema.strip()),
    topics: z.array(doorStatus.EventTopicSubscriptionsSchema.strip()),
  }).strip(),
  services: doorStatus.ServicesStatusSchema.extend({
    declarations: doorStatus.ServiceDeclarationsStatusSchema.extend({
      descriptors: z.array(
        doorStatus.ServiceDescriptorReadingSchema.extend({ state: descriptorState }).strip(),
      ),
      refused: z.array(doorStatus.ServiceLocalRefusalSchema.strip()),
      lanes: z.array(
        doorStatus.ServiceLaneDeclarationSchema.extend({
          refused: z.array(ServiceDeclareRefusalSchema.strip()),
        }).strip(),
      ),
    }).strip(),
  }).strip(),
  bundle: FleetNodeStatusSchema,
  admission: doorStatus.AdmissionStatusSchema.strip(),
  config: doorStatus.ConfigOriginSchema.strip().nullable(),
  release: ReleaseStandingSchema.strip(),
  application: ApplicationStatusReaderSchema,
  nodes: z.array(PresenceReaderSchema),
}).strip();
export type StatusResult = z.output<typeof StatusResultSchema>;

const KNOWN_DELAY_STATES = new Set<string>(
  EventLoopDelaySnapshotSchema.options.map((option) => option.shape.state.value),
);
// Every state the writer sends, taken from the writer's own list: a state it adds is read as itself.
const EventLoopDelayReaderSchema = z.union([
  ...EventLoopDelaySnapshotSchema.options.map((option) => option.strip()),
  // A state of a newer broker carries fields this release cannot interpret; only the fact remains.
  z
    .object({ state: z.string().refine((state) => !KNOWN_DELAY_STATES.has(state)) })
    .transform((): { state: Unrecognized } => ({ state: 'unrecognized' })),
]);

const TransportObservationReaderSchema = TransportObservationSnapshotSchema.extend({
  lastDisconnect: TransportObservationSnapshotSchema.shape.lastDisconnect.unwrap().strip().nullable(),
  eventLoopDelay: EventLoopDelayReaderSchema,
}).strip();

const brokerFleet = BrokerHealthContractSchema.shape.fleet;
const brokerEvents = BrokerHealthContractSchema.shape.events;
const brokerTopic = BrokerHealthContractSchema.shape.topics.element;

/**
 * Forward-compatible reader for the broker `/health` response. The `transport`, `application`,
 * `bundle` and `admission` blocks are optional: a broker of an earlier release that does not write
 * one is still read, and a check that needs the block reports it unknown.
 */
export const BrokerHealthSchema = BrokerHealthContractSchema.extend({
  nodes: z.array(PresenceReaderSchema),
  transport: TransportObservationReaderSchema.optional(),
  audit: AuditStatusSchema,
  fleet: brokerFleet
    .extend({
      machines: z.array(
        brokerFleet.shape.machines.element
          .extend({ release: ReleaseStandingSchema.strip(), behind: BehindByReaderSchema })
          .strip(),
      ),
    })
    .strip(),
  application: ApplicationStatusReaderSchema.optional(),
  bundle: FleetEditionStatusSchema.optional(),
  streams: BrokerHealthContractSchema.shape.streams.strip(),
  events: brokerEvents.extend({ recent: brokerEvents.shape.recent.strip() }).strip(),
  topics: z.array(
    brokerTopic
      .extend({
        source: knownOrUnrecognized(brokerTopic.shape.source),
        publicationMode: knownOrUnrecognized(brokerTopic.shape.publicationMode),
        cadence: brokerTopic.shape.cadence.strip(),
        limits: brokerTopic.shape.limits.strip(),
        retention: brokerTopic.shape.retention.unwrap().strip().nullable(),
      })
      .strip(),
  ),
  admission: BrokerHealthContractSchema.shape.admission.strip().optional(),
}).strip();
export type BrokerHealth = z.output<typeof BrokerHealthSchema>;
