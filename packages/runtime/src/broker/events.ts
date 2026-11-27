import {
  acceptedEventAck,
  type EventAck,
  type EventPublish,
  type EventSubscribe,
  type EventUnsubscribe,
  rejectedEventAck,
} from '../../../contracts/src/protocol/event.ts';
import {
  policyRefusal,
  requestRefusal,
  unclassifiedFailure,
} from '../../../contracts/src/protocol/failure.ts';
import type { NodeId } from '../../../contracts/src/protocol/identity.ts';
import type { EventDeclare, EventDeclareAck } from '../../../contracts/src/protocol/topic.ts';
import type { BrokerConfig } from '../config/broker.ts';
import { type EventSink, EventSubscriptions } from './event-subscriptions.ts';
import { EventTopicState, type TopicFlow, type TopicPublishDecision } from './event-topic-state.ts';
import { type TopicLookup, TopicRegistry } from './topic-registry.ts';

export type { EventSink } from './event-subscriptions.ts';
export type { TopicFlow, TopicRetentionFlow } from './event-topic-state.ts';

/**
 * Policy boundary and coordinator for the state owners of the event plane.
 *
 * Which topics exist, producer epochs/retention, and subscriber queues/admission evolve
 * independently. Keeping them in separate owners makes each transition explicit; this class only
 * validates identities and joins an accepted publication to its subscribers.
 */
export class EventRouter {
  private readonly registry: TopicRegistry;
  private readonly subscriptions: EventSubscriptions;
  private readonly topicsState: EventTopicState;

  constructor(config: BrokerConfig, sink: EventSink) {
    this.registry = new TopicRegistry(config);
    this.subscriptions = new EventSubscriptions(config, sink);
    this.topicsState = new EventTopicState(this.registry);
  }

  admissions(minutes: number, now: number): { count: number; windowMs: number } {
    return this.subscriptions.admissions(minutes, now);
  }

  status(): { subscriptions: number; accepted: number; topics: number } {
    return { ...this.subscriptions.status(), topics: this.topicsState.liveTopics() };
  }

  topics(now: number): TopicFlow[] {
    return this.topicsState.flows(now, (topic) => this.subscriptions.countTopic(topic));
  }

  lookup(topic: string): TopicLookup {
    return this.registry.lookup(topic);
  }

  declare(nodeId: NodeId, request: EventDeclare): EventDeclareAck {
    const { ack, withdrawn, changed } = this.registry.declare(nodeId, request);
    this.topicsState.forget(withdrawn);
    this.subscriptions.withdraw(withdrawn);
    for (const [name, declaration] of changed) this.subscriptions.reauthorize(name, declaration);
    return ack;
  }

  subscribe(request: EventSubscribe, socketId: string): EventAck {
    const topic = this.registry.resolve(request.topic);
    if (topic === undefined) return rejectedEventAck(unclassifiedFailure('rejected', 'unknown topic'));
    if (!topic.subscribers.includes(request.subscriber))
      return rejectedEventAck(policyRefusal('subscriber is outside the topic allowlist'));
    const ack = this.subscriptions.subscribe(request, socketId, topic);
    if (ack.ok)
      this.subscriptions.seedResume(
        request.subscriptionId,
        request.resume,
        this.topicsState.resumePoint(request.topic),
      );
    return ack;
  }

  unsubscribe(nodeId: NodeId, request: EventUnsubscribe): EventAck {
    return this.subscriptions.unsubscribe(nodeId, request);
  }

  publish(nodeId: NodeId, event: EventPublish, socketId: string): EventAck {
    const topic = this.registry.resolve(event.topic);
    if (topic === undefined) return rejectedEventAck(unclassifiedFailure('rejected', 'unknown topic'));
    if (topic.producer !== nodeId || event.producer !== nodeId)
      return rejectedEventAck(
        unclassifiedFailure('rejected', 'authenticated node is not the declared topic producer'),
      );
    if (event.bytes > topic.maxEventBytes)
      return this.decision(
        this.topicsState.reject(event.topic, requestRefusal('event exceeds topic byte limit')),
      );

    const decision = this.topicsState.accept(event, socketId);
    if (!decision.accepted) return this.decision(decision);
    // The boundary travels with the event that proves the new boot was accepted, so the event queued
    // right after it is what delivers the marker.
    if (decision.previousBoot !== null)
      this.subscriptions.onBootChange(event.topic, topic.producer, decision.previousBoot, event.bootId);
    this.subscriptions.publish(event, decision.skipped);
    return acceptedEventAck();
  }

  disconnect(socketId: string, nodeId: NodeId): void {
    this.subscriptions.disconnect(socketId);
    this.topicsState.disconnect(socketId, nodeId);
  }

  stop(): void {
    this.subscriptions.stop();
    this.topicsState.stop();
  }

  private decision(decision: TopicPublishDecision): EventAck {
    return decision.accepted ? acceptedEventAck() : rejectedEventAck(decision.refused);
  }
}
