import {
  type BoundedChannel,
  type BoundedOperationLease,
  createBoundedAdmission,
  createBoundedChannel,
} from 'stitchkit/application';
import type {
  EventAck,
  EventDeliveryAck,
  EventError,
  EventFrame,
  EventGap,
  EventPublish,
  EventResume,
  EventSubscribe,
  EventUnsubscribe,
} from '../../../contracts/src/protocol/event.ts';
import { acceptedEventAck, eventGap, rejectedEventAck } from '../../../contracts/src/protocol/event.ts';
import {
  capacityRefusal,
  policyRefusal,
  type Refused,
  requestRefusal,
  transportFailure,
  unclassifiedFailure,
} from '../../../contracts/src/protocol/failure.ts';
import type { NodeId } from '../../../contracts/src/protocol/identity.ts';
import type { TopicDeclaration } from '../../../contracts/src/protocol/topic.ts';
import type { BrokerConfig } from '../config/broker.ts';
import { eventDeliverySize } from '../event-delivery-size.ts';
import type { AnnouncedBoot, ResumePoint } from './event-topic-state.ts';

export type EventDelivery =
  | { kind: 'event'; value: EventFrame }
  | { kind: 'gap'; value: EventGap }
  | { kind: 'error'; value: EventError };

export interface EventSink {
  deliver(socketId: string, delivery: EventDelivery, acknowledge: (ack: EventDeliveryAck) => void): void;
}

interface SubscriptionState {
  lease: BoundedOperationLease;
  request: EventSubscribe;
  socketId: string;
  topic: TopicDeclaration;
  delivery: BoundedChannel<EventDelivery>;
  latestSeq: number | null;
  queuedGap: EventGap | null;
  pendingGap: EventGap | null;
  inFlight: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Owns subscription admission, replay, queues and acknowledgement lifetimes. */
export class EventSubscriptions {
  private readonly states = new Map<string, SubscriptionState>();
  private readonly admission;
  private readonly admissionsByMinute = new Map<number, number>();
  private accepted = 0;

  constructor(
    config: BrokerConfig,
    private readonly sink: EventSink,
  ) {
    // Every node that may ever hold a subscription here: readers of fleet topics and readers a
    // namespace admits alike, since an owner's topic can appear after this is built.
    const identities = new Set([
      ...config.nodes.map((node) => node.id),
      ...Object.values(config.topics).flatMap((topic) => topic.subscribers),
      ...Object.values(config.topicNamespaces).flatMap((grant) => grant.subscribers),
    ]);
    this.admission = createBoundedAdmission({
      policy: {
        global: { maxConcurrent: config.admission.maxEventSubscriptionsTotal },
        perKey: {
          maxConcurrent: config.admission.maxEventSubscriptionsTotal,
          maxKeys: Math.max(1, identities.size),
          rate: { limit: config.admission.maxEventSubscribesPerMinute, intervalMs: 60_000 },
        },
      },
    });
  }

  subscribe(request: EventSubscribe, socketId: string, topic: TopicDeclaration): EventAck {
    if (this.states.has(request.subscriptionId))
      return rejectedEventAck(requestRefusal('subscription id is already active', 'rejected'));
    const holders = this.subscribersOf(request.topic);
    if (!holders.has(request.subscriber) && holders.size >= topic.maxSubscribers)
      return rejectedEventAck(
        capacityRefusal(
          `topic subscriber limit reached (${holders.size}/${topic.maxSubscribers}: ${[...holders].sort().join(', ')})`,
        ),
      );
    const admitted = this.admission.acquire(request.subscriber);
    if (admitted.outcome === 'refused')
      return rejectedEventAck(
        capacityRefusal(
          admitted.reason === 'key-rate'
            ? 'node subscription rate limit reached'
            : 'broker event subscription limit reached',
          admitted.retryAfterMs ?? null,
        ),
      );
    this.states.set(request.subscriptionId, {
      lease: admitted.lease,
      request,
      socketId,
      topic,
      delivery: this.deliveryChannel(topic),
      latestSeq: null,
      queuedGap: null,
      pendingGap: null,
      inFlight: false,
      timer: null,
    });
    this.accepted += 1;
    this.recordAdmission(Date.now());
    return acceptedEventAck();
  }

  seedResume(subscriptionId: string, resume: EventResume | null, sequence: ResumePoint | undefined): void {
    if (resume === null) return;
    const state = this.states.get(subscriptionId);
    if (state === undefined) return;
    if (sequence === undefined) {
      this.pushDelivery(state, {
        kind: 'gap',
        value: this.gap(state, resume.bootId, resume.afterSeq, resume.afterSeq, 'resume'),
      });
      this.schedule(state);
      return;
    }
    if (sequence.bootId !== resume.bootId) {
      this.pushDelivery(state, {
        kind: 'gap',
        value: this.gap(
          state,
          resume.bootId,
          resume.afterSeq,
          resume.afterSeq,
          'boot-change',
          sequence.bootId,
        ),
      });
      this.schedule(state);
      return;
    }
    const missingFrom = resume.afterSeq + 1;
    if (missingFrom >= sequence.nextSeq) return;
    const replay = sequence.retained
      .filter((held) => held.publish.seq >= missingFrom)
      .slice(-state.topic.queueDepth);
    const firstReplaySeq = replay[0]?.publish.seq ?? sequence.nextSeq;
    if (firstReplaySeq > missingFrom)
      this.pushDelivery(state, {
        kind: 'gap',
        value: this.gap(
          state,
          resume.bootId,
          missingFrom,
          firstReplaySeq - 1,
          state.topic.retain.maxBytes === 0 ? 'resume' : 'retention',
        ),
      });
    for (const held of replay)
      this.pushDelivery(state, {
        kind: 'event',
        value: { ...held.publish, subscriptionId: state.request.subscriptionId },
      });
    this.schedule(state);
  }

  publish(event: EventPublish, skipped: { fromSeq: number; toSeq: number } | null): void {
    for (const state of this.states.values()) {
      if (state.request.topic !== event.topic) continue;
      const frame: EventFrame = { ...event, subscriptionId: state.request.subscriptionId };
      if (skipped !== null && state.topic.delivery !== 'latest-wins')
        this.pushDelivery(state, {
          kind: 'gap',
          value: this.gap(state, event.bootId, skipped.fromSeq, skipped.toSeq, 'overflow'),
        });
      this.enqueue(state, frame);
    }
  }

  onBootChange(topicName: string, producer: NodeId, previous: AnnouncedBoot, nextBootId: string): void {
    for (const state of this.states.values()) {
      if (state.request.topic !== topicName) continue;
      const oldBoundary =
        state.queuedGap?.reason === 'boot-change'
          ? state.queuedGap
          : state.pendingGap?.reason === 'boot-change'
            ? state.pendingGap
            : null;
      state.delivery.close({ mode: 'discard' });
      state.delivery = this.deliveryChannel(state.topic);
      state.queuedGap = null;
      // An overflow left over from the old boot goes with it: kept, it would turn the new boot's
      // events into overflow gaps until the queue next emptied.
      state.pendingGap = null;
      state.latestSeq = null;
      const gap = eventGap({
        subscriptionId: state.request.subscriptionId,
        topic: topicName,
        producer,
        bootId: oldBoundary?.bootId ?? previous.bootId,
        fromSeq: oldBoundary?.fromSeq ?? Math.max(0, previous.nextSeq - 1),
        toSeq: oldBoundary?.toSeq ?? Math.max(0, previous.nextSeq - 1),
        reason: 'boot-change',
        nextBootId,
      });
      if (state.topic.delivery === 'ordered') this.pushDelivery(state, { kind: 'gap', value: gap });
      else state.pendingGap = gap;
    }
  }

  /**
   * The producer no longer declares these topics: their subscribers are told the producer is gone,
   * the answer a subscriber to a not-yet-declared topic gets, so it waits and asks again instead of
   * holding a slot on a name nobody publishes.
   */
  withdraw(topics: readonly string[]): void {
    for (const state of [...this.states.values()]) {
      if (!topics.includes(state.request.topic)) continue;
      this.terminate(
        state,
        transportFailure('target-offline', `topic '${state.request.topic}' was withdrawn by its producer`),
      );
    }
  }

  /**
   * The producer declared this topic again under another declaration. A subscriber its allowlist no
   * longer names loses the subscription with the refusal a new subscribe would get; the others keep
   * theirs and are held to the new declaration from now on.
   *
   * A queue is built for the delivery mode and the depth and byte size it was given and cannot be
   * resized in place. A subscription whose queue the new declaration outgrows (another delivery
   * mode, a deeper queue, larger events) is ended like a withdrawn topic, so its subscriber asks
   * again and resumes into a queue of the right shape; narrowing needs no new queue.
   */
  reauthorize(topicName: string, declaration: TopicDeclaration): void {
    for (const state of [...this.states.values()]) {
      if (state.request.topic !== topicName) continue;
      if (!declaration.subscribers.includes(state.request.subscriber)) {
        this.terminate(state, policyRefusal('subscriber is outside the topic allowlist'));
        continue;
      }
      const built = state.topic;
      state.topic = declaration;
      if (
        declaration.delivery !== built.delivery ||
        declaration.queueDepth > built.queueDepth ||
        declaration.maxEventBytes > built.maxEventBytes
      )
        this.terminate(
          state,
          transportFailure('target-offline', `topic '${topicName}' was redeclared with another queue shape`),
        );
    }
  }

  unsubscribe(nodeId: NodeId, request: EventUnsubscribe): EventAck {
    const state = this.states.get(request.subscriptionId);
    if (state === undefined) return rejectedEventAck(unclassifiedFailure('rejected', 'unknown subscription'));
    if (
      state.request.subscriber !== nodeId ||
      request.subscriber !== nodeId ||
      request.topic !== state.request.topic
    )
      return rejectedEventAck(
        unclassifiedFailure('rejected', 'only the authenticated subscriber may close this subscription'),
      );
    this.remove(state);
    return acceptedEventAck();
  }

  disconnect(socketId: string): void {
    for (const state of [...this.states.values()]) {
      if (state.socketId === socketId) this.remove(state);
    }
  }

  stop(): void {
    this.admission.stopAdmission();
    for (const state of [...this.states.values()])
      this.terminate(state, unclassifiedFailure('transport', 'broker shutdown'));
  }

  status(): { subscriptions: number; accepted: number } {
    return { subscriptions: this.states.size, accepted: this.accepted };
  }

  countTopic(topic: string): number {
    return this.subscribersOf(topic).size;
  }

  admissions(minutes: number, now: number): { count: number; windowMs: number } {
    const minute = Math.floor(now / 60_000);
    const oldest = minute - (minutes - 1);
    let count = 0;
    for (const [key, value] of this.admissionsByMinute) if (key >= oldest) count += value;
    return { count, windowMs: now - oldest * 60_000 };
  }

  private recordAdmission(now: number): void {
    const minute = Math.floor(now / 60_000);
    this.admissionsByMinute.set(minute, (this.admissionsByMinute.get(minute) ?? 0) + 1);
    for (const key of this.admissionsByMinute.keys())
      if (key <= minute - 60) this.admissionsByMinute.delete(key);
  }

  private pushDelivery(
    state: SubscriptionState,
    delivery: { kind: 'event'; value: EventFrame } | { kind: 'gap'; value: EventGap },
  ): void {
    if (state.topic.delivery === 'latest-wins') {
      if (delivery.kind === 'gap') state.pendingGap = delivery.value;
      else {
        state.delivery.offer(delivery);
        state.latestSeq = delivery.value.seq;
      }
      return;
    }
    state.delivery.offer(delivery);
    if (delivery.kind === 'gap') state.queuedGap = delivery.value;
  }

  private enqueue(state: SubscriptionState, frame: EventFrame): void {
    if (state.topic.delivery === 'latest-wins') {
      if (state.latestSeq !== null)
        this.mergeGap(state, state.latestSeq, frame.seq - 1, 'latest-wins', frame.bootId);
      state.delivery.offer({ kind: 'event', value: frame });
      state.latestSeq = frame.seq;
    } else if (state.pendingGap !== null) {
      this.mergeGap(state, frame.seq, frame.seq, 'overflow', frame.bootId);
    } else {
      const eventCount = state.delivery.getSnapshot().queuedItems - (state.queuedGap === null ? 0 : 1);
      if (eventCount >= state.topic.queueDepth)
        this.mergeGap(state, frame.seq, frame.seq, 'overflow', frame.bootId);
      else state.delivery.offer({ kind: 'event', value: frame });
    }
    this.schedule(state);
  }

  private mergeGap(
    state: SubscriptionState,
    fromSeq: number,
    toSeq: number,
    reason: EventGap['reason'],
    bootId: string,
  ): void {
    if (toSeq < fromSeq) return;
    const previous = state.pendingGap;
    state.pendingGap =
      previous?.bootId === bootId && previous.reason === reason
        ? eventGap({
            ...previous,
            fromSeq: Math.min(previous.fromSeq, fromSeq),
            toSeq: Math.max(previous.toSeq, toSeq),
          })
        : this.gap(state, bootId, fromSeq, toSeq, reason);
  }

  private gap(
    state: SubscriptionState,
    bootId: string,
    fromSeq: number,
    toSeq: number,
    reason: EventGap['reason'],
    nextBootId?: string,
  ): EventGap {
    return eventGap({
      subscriptionId: state.request.subscriptionId,
      topic: state.request.topic,
      producer: state.topic.producer,
      bootId,
      fromSeq,
      toSeq,
      reason,
      ...(nextBootId === undefined ? {} : { nextBootId }),
    });
  }

  private deliveryChannel(topic: TopicDeclaration): BoundedChannel<EventDelivery> {
    return createBoundedChannel<EventDelivery>({
      policy: topic.delivery === 'latest-wins' ? 'latest' : 'ordered',
      maxItems: topic.queueDepth + 1,
      maxBytes: (topic.queueDepth + 1) * (topic.maxEventBytes * 2 + 8192),
      sizeOf: (delivery) =>
        Buffer.byteLength(JSON.stringify({ kind: delivery.kind, value: null })) -
        4 +
        eventDeliverySize(delivery.value),
    });
  }

  /** A state that was removed, or replaced under its id, must not act any more. */
  private live(state: SubscriptionState): boolean {
    return this.states.get(state.request.subscriptionId) === state;
  }

  private schedule(state: SubscriptionState): void {
    if (!this.live(state) || state.inFlight) return;
    state.inFlight = true;
    setTimeout(() => void this.drain(state), 0);
  }

  private async drain(state: SubscriptionState): Promise<void> {
    if (!this.live(state)) return;
    let delivery: EventDelivery | undefined;
    if (state.topic.delivery === 'latest-wins') {
      if (state.pendingGap !== null) {
        delivery = { kind: 'gap', value: state.pendingGap };
        state.pendingGap = null;
      } else if (state.delivery.getSnapshot().queuedItems > 0) {
        state.latestSeq = null;
        delivery = await this.takeCurrent(state);
        if (delivery === undefined && !this.live(state)) return;
      }
    } else if (state.delivery.getSnapshot().queuedItems > 0) {
      state.queuedGap = null;
      delivery = await this.takeCurrent(state);
      if (delivery === undefined && !this.live(state)) return;
    } else if (state.pendingGap !== null) {
      delivery = { kind: 'gap', value: state.pendingGap };
      state.pendingGap = null;
    }
    if (delivery === undefined) {
      state.inFlight = false;
      return;
    }
    let settled = false;
    state.timer = setTimeout(() => {
      if (settled || !this.live(state)) return;
      settled = true;
      this.terminate(state, unclassifiedFailure('timeout', 'subscriber delivery acknowledgement timed out'));
    }, state.topic.subscriberIdleMs);
    this.sink.deliver(state.socketId, delivery, (ack) => {
      if (settled || !this.live(state)) return;
      settled = true;
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      if (!ack.accepted) {
        this.terminate(
          state,
          ack.refusal === 'capacity'
            ? capacityRefusal(`subscriber rejected delivery: ${ack.detail}`)
            : unclassifiedFailure('denied', `subscriber rejected delivery: ${ack.detail}`),
        );
        return;
      }
      setTimeout(() => void this.drain(state), 0);
    });
  }

  private async takeCurrent(state: SubscriptionState): Promise<EventDelivery | undefined> {
    const channel = state.delivery;
    const next = await channel.next();
    if (!this.live(state)) return undefined;
    if (channel !== state.delivery) {
      setTimeout(() => void this.drain(state), 0);
      return undefined;
    }
    return next.done ? undefined : next.value;
  }

  private terminate(state: SubscriptionState, refused: Refused): void {
    if (!this.live(state)) return;
    const error: EventError = {
      subscriptionId: state.request.subscriptionId,
      topic: state.request.topic,
      from: 'broker',
      ...refused,
    };
    this.sink.deliver(state.socketId, { kind: 'error', value: error }, () => {});
    this.remove(state);
  }

  private remove(state: SubscriptionState): void {
    const subscriptionId = state.request.subscriptionId;
    if (!this.live(state)) return;
    this.states.delete(subscriptionId);
    if (state.timer !== null) clearTimeout(state.timer);
    state.delivery.close({ mode: 'discard' });
    state.lease.release();
  }

  private subscribersOf(topic: string): Set<NodeId> {
    const nodes = new Set<NodeId>();
    for (const state of this.states.values())
      if (state.request.topic === topic) nodes.add(state.request.subscriber);
    return nodes;
  }
}
