import { z } from 'zod';
import { ApplicationStatusSchema, AuditStatusSchema } from '../door/status.ts';
import { FleetEditionStatusSchema } from '../fleet/status.ts';
import { MAX_NODES } from './bounds.ts';
import { NodeIdSchema } from './identity.ts';
import { laneUrlRefusal } from './lane-url.ts';
import { PresenceSchema } from './presence.ts';
import { BehindBySchema, ReleaseStandingSchema } from './release.ts';

/** `maxMs` is the worst delay inside the trailing `windowMs`, not since the broker started. */
export const EventLoopDelaySnapshotSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('unknown'),
    sampledAt: z.null(),
    lastMs: z.null(),
    maxMs: z.null(),
    windowMs: z.number().int().min(1),
  }),
  z.strictObject({
    state: z.literal('measured'),
    sampledAt: z.iso.datetime(),
    lastMs: z.number().min(0),
    maxMs: z.number().min(0),
    windowMs: z.number().int().min(1),
  }),
]);
export type EventLoopDelaySnapshot = z.infer<typeof EventLoopDelaySnapshotSchema>;

export const TransportObservationSnapshotSchema = z.strictObject({
  broker: z.string(),
  lastDisconnect: z
    .strictObject({ nodeId: NodeIdSchema, reason: z.string().max(256), observedAt: z.iso.datetime() })
    .nullable(),
  eventLoopDelay: EventLoopDelaySnapshotSchema,
});
export type TransportObservationSnapshot = z.infer<typeof TransportObservationSnapshotSchema>;

export const BrokerFleetMachineSchema = z.strictObject({
  nodeId: NodeIdSchema,
  online: z.boolean(),
  release: ReleaseStandingSchema,
  behind: BehindBySchema,
});

/**
 * Which build every machine on this wire carries, and how far behind it is.
 *
 * The broker is the only party that can answer this. It is the reference by construction — it
 * admits its own version and nothing else — and it is the only one that ever sees the build of a
 * node it REFUSED, in the instant before refusing it. Without this, a node left on an older
 * artifact reads as `offline`, the same word a broken network earns, and the two need opposite
 * repairs.
 */
export const BrokerFleetStatusSchema = z.strictObject({
  latest: z.string().max(64),
  latestAt: z.string().max(64).nullable(),
  machines: z.array(BrokerFleetMachineSchema),
});

export const BrokerEventsHealthSchema = z.strictObject({
  subscriptions: z.number().int().min(0),
  /** Lifetime admissions. Far above `subscriptions` means a consumer is re-opening rather than
   *  holding — the shape that once burned 17 % of a core and 400 MB of journal a day while every
   *  individual record said `accepted: true`. */
  accepted: z.number().int().min(0),
  topics: z.number().int().min(0),
  /**
   * Admissions inside a recent window, and the span that count really covers.
   *
   * `accepted` above is a lifetime total, and a lifetime total can only become a rate by being
   * differenced against an earlier reading — which makes the answer depend on when the reader last
   * looked rather than on what is happening. `windowMs` is reported because the newest minute is
   * partial: divide by what was measured, not by a round number that would understate a burst
   * exactly as it starts.
   */
  recent: z.strictObject({
    count: z.number().int().min(0),
    windowMs: z.number().int().min(0),
  }),
});

/** Declared bounds beside actual occupancy, because a window nobody ever falls inside and one that
 *  is always full need opposite repairs. */
export const BrokerTopicRetentionHealthSchema = z.strictObject({
  maxAgeMs: z.number().int().min(0),
  maxBytes: z.number().int().min(0),
  events: z.number().int().min(0),
  bytes: z.number().int().min(0),
  oldestAgeMs: z.number().int().min(0).nullable(),
});

/** Per-topic flow and ceilings. Transport health says the broker is alive; this says whether
 *  anything is still arriving, which is the question a silent fleet actually raises. */
export const BrokerTopicHealthSchema = z.strictObject({
  topic: z.string(),
  /** `fleet`: declared by this broker's configuration. `owner`: declared by its producer inside a
   *  granted namespace, and gone when that producer withdraws it. */
  source: z.enum(['fleet', 'owner']),
  producer: z.string(),
  publisherLive: z.boolean(),
  sinceLastPublishMs: z.number().int().min(0).nullable(),
  cadence: z.strictObject({ count: z.number().int().min(0), windowMs: z.number().int().min(0) }),
  publicationMode: z.enum(['periodic', 'on-change', 'unknown']),
  /** Refusals from the authenticated declared producer are visible separately from accepted flow,
   *  so a topic losing every publish cannot look merely quiet. */
  rejectedPublishes: z.number().int().min(0),
  sinceLastRejectionMs: z.number().int().min(0).nullable(),
  subscribers: z.number().int().min(0),
  limits: z.strictObject({
    maxSubscribers: z.number().int().min(0),
    maxEventsPerSecond: z.number().int().min(0),
    maxEventBytes: z.number().int().min(0),
  }),
  /** Null when the topic retains nothing. */
  retention: BrokerTopicRetentionHealthSchema.nullable(),
});

/** The per-caller ceilings this broker enforces. A client that knows them can pace itself; without
 *  them the only way to learn a limit is to be refused by it. */
export const BrokerAdmissionHealthSchema = z.strictObject({
  maxInflightPerNode: z.number().int().min(0),
  maxCallsPerMinutePerNode: z.number().int().min(0),
  maxStreamsTotal: z.number().int().min(0),
  maxStreamsPerCaller: z.number().int().min(0),
  maxStreamsPerProducer: z.number().int().min(0),
  maxStreamOpensPerMinute: z.number().int().min(0),
  maxEventSubscriptionsTotal: z.number().int().min(0),
  maxEventSubscribesPerMinute: z.number().int().min(0),
});

/**
 * What a broker writes on `/health`. Strict, because this is the boundary of writing: a field the
 * broker did not declare is a leak of its internals and fails the response rather than reaching a
 * reader. Every reader — doctor, enrollment, operator tools, the SDK — reads it with the tolerant
 * `BrokerHealthSchema` of `@stitchwire/client/contracts` instead, because a fleet always runs more
 * than one release and a broker of the next one adds fields this one does not know.
 */
export const BrokerHealthContractSchema = z.strictObject({
  ok: z.boolean(),
  nodes: z.array(PresenceSchema).max(MAX_NODES),
  /**
   * Since when this broker can answer "did that node leave, and how".
   *
   * `departure: null` on a row is two facts wearing one value — the node never left, or this
   * broker restarted since and forgot. That ambiguity is at its worst exactly after a rollout, when
   * every row is null and the reassuring reading is the wrong one. The horizon makes the two
   * separable without asking anyone to remember how the registry is stored.
   */
  observingSince: z.string(),
  transport: TransportObservationSnapshotSchema,
  audit: AuditStatusSchema,
  fleet: BrokerFleetStatusSchema,
  /** The lifecycle kernel's verdict about this process, beside the domain rather than folded into
   *  `ok`. `ok` is and stays an audit fact — the journal is losing nothing — while `ready` and
   *  `health` are facts about the process; one field cannot carry both honestly. */
  application: ApplicationStatusSchema,
  /** The fleet bundle this broker keeps and hands on, and whether its tables match it. */
  bundle: FleetEditionStatusSchema,
  streams: z.strictObject({ active: z.number().int().min(0) }),
  events: BrokerEventsHealthSchema,
  topics: z.array(BrokerTopicHealthSchema),
  admission: BrokerAdmissionHealthSchema,
});
export type BrokerHealth = z.infer<typeof BrokerHealthContractSchema>;

/**
 * Derive the HTTP(S) `/health` endpoint URL from a broker lane URL (`ws://`, `wss://`, `http://`,
 * `https://`). The lane is judged by the one lane rule, `laneUrlRefusal`, so plain text outside
 * loopback is refused here as everywhere else; the error names the rule, never the URL.
 */
export function brokerHealthUrl(laneUrl: string): string {
  const refusal = laneUrlRefusal(laneUrl);
  if (refusal !== null) throw new TypeError(`Invalid broker lane URL: ${refusal}`);
  const parsed = new URL(laneUrl);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  const basePath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = basePath.endsWith('/health') ? basePath : `${basePath}/health`;
  return parsed.toString();
}
