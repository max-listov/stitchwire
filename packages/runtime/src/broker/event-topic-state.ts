import { type BoundedAdmission, createBoundedAdmission } from 'stitchkit/application';
import type { BrokerHealth } from '../../../contracts/src/protocol/broker-health.ts';
import type { EventPublish } from '../../../contracts/src/protocol/event.ts';
import {
  capacityRefusal,
  type Refused,
  unclassifiedFailure,
} from '../../../contracts/src/protocol/failure.ts';
import type { NodeId } from '../../../contracts/src/protocol/identity.ts';
import type { TopicDeclaration } from '../../../contracts/src/protocol/topic.ts';
import { PublicationCadence } from './publication-cadence.ts';
import type { TopicRegistry, TopicSource } from './topic-registry.ts';

interface RetainedEvent {
  publish: EventPublish;
  at: number;
}

export interface EventSequenceState {
  bootId: string;
  nextSeq: number;
  socketId: string | null;
  lastAcceptedAt: number;
  retained: RetainedEvent[];
  retainedBytes: number;
}

export interface TopicRetentionFlow {
  maxAgeMs: number;
  maxBytes: number;
  events: number;
  bytes: number;
  oldestAgeMs: number | null;
}

export interface TopicFlow {
  cadence: { count: number; windowMs: number };
  publicationMode: BrokerHealth['topics'][number]['publicationMode'];
  topic: string;
  source: TopicSource;
  producer: string;
  publisherLive: boolean;
  sinceLastPublishMs: number | null;
  rejectedPublishes: number;
  sinceLastRejectionMs: number | null;
  subscribers: number;
  limits: { maxSubscribers: number; maxEventsPerSecond: number; maxEventBytes: number };
  retention: TopicRetentionFlow | null;
}

/** What a resume is replayed from: a boot, its high-water and what is retained of it. */
export type ResumePoint = Pick<EventSequenceState, 'bootId' | 'nextSeq' | 'retained'>;

/** The last producer boot the topic's subscribers were told of, with that boot's high-water. */
export interface AnnouncedBoot {
  bootId: string;
  nextSeq: number;
}

export type TopicPublishDecision =
  | {
      accepted: true;
      skipped: { fromSeq: number; toSeq: number } | null;
      /** Set when this event is the first accepted one after the announced boot ended. */
      previousBoot: AnnouncedBoot | null;
    }
  | { accepted: false; refused: Refused };

/**
 * The publish allowance of one topic, built for the limit the topic declares now, and the one
 * boot opening per second it may take beyond that limit.
 *
 * A producer that restarts inside the second its old boot used up must not lose the first event of
 * its new boot to the rate: that is the ordinary restart, and its reader would see the boundary late.
 * The opening allowance admits it. It is one per second for the topic, not one per boot, so a
 * producer that starts a boot for every event gets at most one event a second above the limit.
 */
interface TopicRate {
  limit: number;
  admission: BoundedAdmission;
  opening: BoundedAdmission;
}

function perSecond(limit: number): BoundedAdmission {
  return createBoundedAdmission({
    policy: { global: { maxConcurrent: 1, rate: { limit, intervalMs: 1_000 } } },
  });
}

/** Owns producer epochs, cadence and retention; it knows nothing about subscriber queues. */
export class EventTopicState {
  private readonly sequences = new Map<string, EventSequenceState>();
  private readonly cadence = new Map<string, PublicationCadence>();
  private readonly rejections = new Map<string, { count: number; lastAt: number }>();
  private readonly rates = new Map<string, TopicRate>();
  /**
   * Subscribers learn of a boot boundary with the first accepted event of the new boot and not
   * before: a producer that starts a boot per event would otherwise send them one marker per
   * attempt, refused or not, and the topic rate would hold only what the broker accepts. A boot
   * taken but refused is not announced, so a chain of refused boots reaches them as one boundary,
   * from the last announced boot to the first accepted one.
   */
  private readonly announced = new Map<string, AnnouncedBoot>();

  constructor(private readonly registry: TopicRegistry) {}

  accept(event: EventPublish, socketId: string): TopicPublishDecision {
    const topic = this.registry.resolve(event.topic);
    if (topic === undefined)
      return {
        accepted: false,
        refused: unclassifiedFailure('rejected', 'unknown topic'),
      };
    let current = this.sequences.get(event.topic);
    let skipped: { fromSeq: number; toSeq: number } | null = null;
    const now = Date.now();
    if (current === undefined || current.bootId !== event.bootId) {
      if (current !== undefined && current.socketId !== null && event.seq !== 0)
        return this.refuse(
          event.topic,
          unclassifiedFailure('rejected', 'a replacement producer boot must start at sequence 0'),
        );
      // A boot transition is always taken, before the rate is asked: the allowance belongs to the
      // topic, so a producer that starts a boot per event is held to it like one that does not, and
      // refusing the transition itself would leave the next event refused for not starting a boot,
      // the stream wedged until the following restart. The refused event is not consumed
      // (`nextSeq` stays at it), so its retry is judged by the rate and the opening allowance again.
      if (current !== undefined) {
        current.retained = [];
        current.retainedBytes = 0;
      }
      current = this.epoch(event, socketId, current?.lastAcceptedAt ?? now);
      this.sequences.set(event.topic, current);
    } else {
      if (current.socketId === null) current.socketId = socketId;
      else if (current.socketId !== socketId)
        return this.refuse(
          event.topic,
          unclassifiedFailure('rejected', 'producer boot is owned by another authenticated connection'),
        );
      if (event.seq < current.nextSeq)
        return this.refuse(
          event.topic,
          unclassifiedFailure('rejected', `expected sequence ${current.nextSeq}, received ${event.seq}`),
        );
    }
    const rate = this.rateOf(topic, event.topic);
    // A boot none of whose events was accepted yet is still opening: its first event, or the retry
    // of a refused first event.
    const opening = this.announced.get(event.topic)?.bootId !== current.bootId;
    const admitted = rate.admission.acquire();
    if (admitted.outcome === 'leased') admitted.lease.release();
    else {
      const opened = opening ? rate.opening.acquire() : null;
      if (opened === null || opened.outcome === 'refused')
        return this.refuse(
          event.topic,
          capacityRefusal('topic publish rate reached', admitted.retryAfterMs ?? null),
        );
      opened.lease.release();
    }
    if (event.seq > current.nextSeq) skipped = { fromSeq: current.nextSeq, toSeq: event.seq - 1 };
    current.nextSeq = event.seq + 1;
    current.lastAcceptedAt = now;
    let cadence = this.cadence.get(event.topic);
    if (cadence === undefined) {
      cadence = new PublicationCadence();
      this.cadence.set(event.topic, cadence);
    }
    cadence.record(now);
    this.retain(topic, current, event, now);
    return { accepted: true, skipped, previousBoot: this.announce(event.topic, current) };
  }

  reject(topic: string, refused: Refused): TopicPublishDecision {
    return this.refuse(topic, refused);
  }

  sequence(topic: string, now = Date.now()): EventSequenceState | undefined {
    const sequence = this.sequences.get(topic);
    const declaration = this.registry.resolve(topic);
    if (sequence !== undefined && declaration !== undefined) this.prune(declaration, sequence, now);
    return sequence;
  }

  /**
   * Where a resuming subscriber is measured from: the boot its subscribers were last told of. A boot
   * taken but not accepted yet is not announced, so a resume is never told of it either; its boundary
   * reaches every subscriber alike, from the announced boot, with the boot's first accepted event.
   * Nothing of the announced boot is retained once a newer boot is taken, so a tail it is missing is
   * reported as a loss rather than replayed.
   */
  resumePoint(topic: string, now = Date.now()): ResumePoint | undefined {
    const sequence = this.sequence(topic, now);
    const announced = this.announced.get(topic);
    if (announced === undefined) return undefined;
    if (sequence !== undefined && sequence.bootId === announced.bootId) return sequence;
    return { bootId: announced.bootId, nextSeq: announced.nextSeq, retained: [] };
  }

  /**
   * Release everything kept for topics that no longer exist. An owner may rename topics as often as
   * it likes; without this every name it ever used would keep its epoch, cadence and retained
   * events for as long as the broker runs.
   */
  forget(topics: readonly string[]): void {
    for (const topic of topics) {
      this.sequences.delete(topic);
      this.cadence.delete(topic);
      this.rejections.delete(topic);
      this.rates.delete(topic);
      this.announced.delete(topic);
    }
  }

  disconnect(socketId: string, nodeId: NodeId): void {
    for (const { name, declaration } of this.registry.entries()) {
      const sequence = this.sequences.get(name);
      if (declaration.producer === nodeId && sequence?.socketId === socketId) sequence.socketId = null;
    }
  }

  stop(): void {
    this.sequences.clear();
    this.announced.clear();
  }

  liveTopics(): number {
    return [...this.sequences.values()].filter((sequence) => sequence.socketId !== null).length;
  }

  flows(now: number, countSubscribers: (topic: string) => number): TopicFlow[] {
    return this.registry.entries().map(({ name, declaration: topic, source }): TopicFlow => {
      const sequence = this.sequence(name, now);
      const rejection = this.rejections.get(name);
      return {
        topic: name,
        source,
        cadence: this.cadence.get(name)?.read(now) ?? { count: 0, windowMs: 0 },
        publicationMode: topic.publicationMode ?? 'unknown',
        producer: topic.producer,
        publisherLive: sequence?.socketId != null,
        sinceLastPublishMs: sequence === undefined ? null : Math.max(0, now - sequence.lastAcceptedAt),
        rejectedPublishes: rejection?.count ?? 0,
        sinceLastRejectionMs: rejection === undefined ? null : Math.max(0, now - rejection.lastAt),
        subscribers: countSubscribers(name),
        limits: {
          maxSubscribers: topic.maxSubscribers,
          maxEventsPerSecond: topic.maxEventsPerSecond,
          maxEventBytes: topic.maxEventBytes,
        },
        retention: this.retentionFlow(topic, sequence, now),
      };
    });
  }

  /** A topic redeclared with another limit starts its allowance over at the new one. */
  private rateOf(topic: TopicDeclaration, name: string): TopicRate {
    const held = this.rates.get(name);
    if (held !== undefined && held.limit === topic.maxEventsPerSecond) return held;
    const rate: TopicRate = {
      limit: topic.maxEventsPerSecond,
      admission: perSecond(topic.maxEventsPerSecond),
      opening: perSecond(1),
    };
    this.rates.set(name, rate);
    return rate;
  }

  /** Moves the announced boot to the accepted event's boot; answers the boot it replaced, if any. */
  private announce(topic: string, current: EventSequenceState): AnnouncedBoot | null {
    const held = this.announced.get(topic);
    if (held !== undefined && held.bootId === current.bootId) {
      held.nextSeq = current.nextSeq;
      return null;
    }
    this.announced.set(topic, { bootId: current.bootId, nextSeq: current.nextSeq });
    return held ?? null;
  }

  /** The epoch of a boot whose first event is not consumed yet: `nextSeq` is that event. */
  private epoch(event: EventPublish, socketId: string, lastAcceptedAt: number): EventSequenceState {
    return {
      bootId: event.bootId,
      nextSeq: event.seq,
      socketId,
      lastAcceptedAt,
      retained: [],
      retainedBytes: 0,
    };
  }

  private refuse(topic: string, refused: Refused): TopicPublishDecision {
    const previous = this.rejections.get(topic);
    this.rejections.set(topic, { count: (previous?.count ?? 0) + 1, lastAt: Date.now() });
    return { accepted: false, refused };
  }

  private retain(
    topic: TopicDeclaration,
    sequence: EventSequenceState,
    event: EventPublish,
    now: number,
  ): void {
    if (topic.retain.maxBytes === 0) return;
    sequence.retained.push({ publish: event, at: now });
    sequence.retainedBytes += event.bytes;
    this.prune(topic, sequence, now);
  }

  private prune(topic: TopicDeclaration, sequence: EventSequenceState, now: number): void {
    while (sequence.retained.length > 0) {
      const oldest = sequence.retained[0];
      if (oldest === undefined) break;
      if (now - oldest.at < topic.retain.maxAgeMs && sequence.retainedBytes <= topic.retain.maxBytes) break;
      sequence.retained.shift();
      sequence.retainedBytes -= oldest.publish.bytes;
    }
    if (sequence.retained.length === 0) sequence.retainedBytes = 0;
  }

  private retentionFlow(
    topic: TopicDeclaration,
    sequence: EventSequenceState | undefined,
    now: number,
  ): TopicRetentionFlow | null {
    if (topic.retain.maxBytes === 0) return null;
    const oldest = sequence?.retained[0];
    return {
      maxAgeMs: topic.retain.maxAgeMs,
      maxBytes: topic.retain.maxBytes,
      events: sequence?.retained.length ?? 0,
      bytes: sequence?.retainedBytes ?? 0,
      oldestAgeMs: oldest === undefined ? null : Math.max(0, now - oldest.at),
    };
  }
}
