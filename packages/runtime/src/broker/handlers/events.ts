import {
  type EventAck,
  EventAckSchema,
  type EventPublish,
  type EventSubscribe,
  type EventUnsubscribe,
  rejectedEventAck,
} from '../../../../contracts/src/protocol/event.ts';
import {
  policyRefusal,
  type Refused,
  transportFailure,
  unclassifiedFailure,
} from '../../../../contracts/src/protocol/failure.ts';
import type { NodeId } from '../../../../contracts/src/protocol/identity.ts';
import {
  type EventDeclare,
  type EventDeclareAck,
  EventDeclareAckSchema,
} from '../../../../contracts/src/protocol/topic.ts';
import type { Audit } from '../audit.ts';
import type { EventRouter } from '../events.ts';
import type { Registry } from '../registry.ts';

/**
 * Everything the event plane decides, with its dependencies named.
 *
 * The dependencies are an explicit parameter list, not closures over the wire builder's locals, so
 * each decision can be read and moved without reading that builder end to end. The registration
 * lines stay at the contract, where the payload types come from; the decisions live here.
 */
export interface EventPlaneDeps {
  readonly audit: Audit;
  readonly registry: Registry;
  readonly eventsRouter: EventRouter;
}

interface Decision {
  readonly accepted: boolean;
  readonly refusal: Refused['refusal'];
  readonly transportCause: Refused['transportCause'];
  readonly detail: string;
}

/**
 * A name inside a granted namespace that its producer has not declared is a producer that has not
 * arrived yet, not a topic that does not exist: after a broker restart every subscriber may come
 * back before the producer declares again. It is answered as the transport fact it is, so the
 * subscribing lane waits and asks again instead of giving up for good.
 */
function undeclared(topic: string, namespace: string, producer: string): Refused {
  return transportFailure(
    'target-offline',
    `topic '${topic}' is in namespace '${namespace}' of ${producer}, which has not declared it`,
  );
}

export function subscribe(
  deps: EventPlaneDeps,
  nodeId: NodeId,
  socketId: string,
  request: EventSubscribe,
  acknowledge: (ack: EventAck) => void,
): void {
  const found = deps.eventsRouter.lookup(request.topic);
  // One record shape, written once, for the accepted and the refused path.
  const record = (decision: Decision): void => {
    deps.audit.write({
      kind: 'event-subscription',
      subscriptionId: request.subscriptionId,
      topic: request.topic,
      subscriber: nodeId,
      resumeFrom: request.resume?.afterSeq ?? null,
      ...decision,
    });
  };
  const refuse = (refused: Refused): void => {
    record({
      accepted: false,
      refusal: refused.refusal,
      transportCause: refused.transportCause,
      detail: refused.detail,
    });
    acknowledge(EventAckSchema.parse(rejectedEventAck(refused)));
  };
  if (request.subscriber !== nodeId) {
    refuse(unclassifiedFailure('rejected', 'subscription identity does not match the authenticated socket'));
    return;
  }
  if (found.state === 'unknown') {
    refuse(unclassifiedFailure('rejected', 'unknown topic'));
    return;
  }
  if (found.state === 'undeclared') {
    refuse(undeclared(request.topic, found.namespace, found.producer));
    return;
  }
  const topic = found.declaration;
  if (!deps.registry.mayPerform('subscribe', nodeId, topic.producer)) {
    refuse(policyRefusal(`subscribe capability does not allow ${nodeId} → ${topic.producer}`));
    return;
  }
  const decision = deps.eventsRouter.subscribe(request, socketId);
  record({
    accepted: decision.ok,
    refusal: decision.refusal,
    transportCause: decision.transportCause ?? null,
    detail: decision.detail,
  });
  acknowledge(EventAckSchema.parse(decision));
}

export function unsubscribe(
  deps: EventPlaneDeps,
  nodeId: NodeId,
  request: EventUnsubscribe,
  acknowledge: (ack: EventAck) => void,
): void {
  acknowledge(EventAckSchema.parse(deps.eventsRouter.unsubscribe(nodeId, request)));
}

export function publish(
  deps: EventPlaneDeps,
  nodeId: NodeId,
  socketId: string,
  event: EventPublish,
  acknowledge: (ack: EventAck) => void,
): void {
  const found = deps.eventsRouter.lookup(event.topic);
  const record = (decision: Decision): void => {
    deps.audit.write({
      kind: 'event-publish',
      topic: event.topic,
      producer: nodeId,
      bootId: event.bootId,
      seq: event.seq,
      bytes: event.bytes,
      cursorPresent: event.cursor !== null,
      ...decision,
    });
  };
  const refuse = (refused: Refused): void => {
    record({
      accepted: false,
      refusal: refused.refusal,
      transportCause: refused.transportCause,
      detail: refused.detail,
    });
    acknowledge(EventAckSchema.parse(rejectedEventAck(refused)));
  };
  if (event.producer !== nodeId) {
    refuse(unclassifiedFailure('rejected', 'publisher identity does not match the authenticated socket'));
    return;
  }
  if (found.state === 'unknown') {
    refuse(unclassifiedFailure('rejected', 'unknown topic'));
    return;
  }
  if (found.state === 'undeclared') {
    refuse(
      unclassifiedFailure(
        'rejected',
        `topic '${event.topic}' is not declared: its producer's topic descriptor must name it first`,
      ),
    );
    return;
  }
  const topic = found.declaration;
  if (!deps.registry.mayPerform('publish', nodeId, topic.producer)) {
    refuse(policyRefusal(`publish capability does not allow ${nodeId} → ${topic.producer}`));
    return;
  }
  const decision = deps.eventsRouter.publish(nodeId, event, socketId);
  record({
    accepted: decision.ok,
    refusal: decision.refusal,
    transportCause: decision.transportCause ?? null,
    detail: decision.detail,
  });
  acknowledge(EventAckSchema.parse(decision));
}

/** A producer states the complete set of topics its owner declares; each name gets its verdict. */
export function declare(
  deps: EventPlaneDeps,
  nodeId: NodeId,
  request: EventDeclare,
  acknowledge: (ack: EventDeclareAck) => void,
): void {
  const ack = deps.eventsRouter.declare(nodeId, request);
  deps.audit.write({
    kind: 'event-declare',
    producer: nodeId,
    accepted: ack.accepted.length,
    refused: ack.refused.length,
    detail: ack.refused
      .slice(0, 8)
      .map((refusal) => `${refusal.topic}: ${refusal.detail}`)
      .join('; '),
  });
  acknowledge(EventDeclareAckSchema.parse(ack));
}
