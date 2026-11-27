import { createBoundedAdmission } from 'stitchkit/application';
import type { LocalEventPublish } from '../../../contracts/src/door/requests.ts';
import {
  type EventAck,
  EventPublishSchema,
  rejectedEventAck,
} from '../../../contracts/src/protocol/event.ts';
import {
  capacityRefusal,
  transportFailure,
  unclassifiedFailure,
} from '../../../contracts/src/protocol/failure.ts';
import type { NodeConfig } from '../config/node.ts';
import type { LaneAgent } from './agent-contract.ts';
import { eventTopicRefusal, type TopicAllowance } from './event-policy.ts';
import type { ConnectedLaneSelection } from './lane-routing.ts';
import type { LocalEventBus } from './local-events.ts';
import { firstAcceptedPublish } from './publish-fanout.ts';

/** One checked envelope is reused by every physical lane and the local source. */
export function prepareEventPublish(nodeId: string, request: LocalEventPublish) {
  const bytes = Buffer.from(request.data, 'utf8');
  return EventPublishSchema.parse({
    ...request,
    producer: nodeId,
    encoding: 'base64',
    data: bytes.toString('base64'),
    bytes: bytes.byteLength,
  });
}

/** The caller withdrew before the event left this node. */
function withdrawnBeforeDispatch(): EventAck {
  return rejectedEventAck(unclassifiedFailure('cancelled', 'the caller withdrew before publish dispatch'));
}

/** One bounded pre-dispatch gate. Physical lane admissions own work after the single handoff. */
export class MultiHomePublisher {
  private readonly waiting;

  constructor(
    private readonly nodeId: string,
    private readonly selector: {
      selectConnected(
        timeoutMs: number,
        signal?: AbortSignal,
      ): Promise<ConnectedLaneSelection<Pick<LaneAgent, 'publishEvent'>>>;
    },
    private readonly localBus: LocalEventBus,
    private readonly admission: NodeConfig['admission'],
    private readonly allowance: TopicAllowance,
  ) {
    // The node's whole publish budget — pending count and rate — is decided here, before the event
    // reaches anyone. A physical lane keeps only its own pending bound: a rate counted per lane
    // would refuse after local delivery had already happened, and with several lanes one lane's
    // count is not the node's.
    this.waiting = createBoundedAdmission({
      policy: {
        global: {
          maxConcurrent: admission.maxPendingPublishes,
          rate: { limit: admission.maxPublishesPerMinute, intervalMs: 60_000 },
        },
      },
    });
  }

  async publish(request: LocalEventPublish, signal?: AbortSignal): Promise<EventAck> {
    const denied = eventTopicRefusal(this.allowance, request.topic, 'publish');
    if (denied !== null) return rejectedEventAck(denied);
    if (signal?.aborted === true) return withdrawnBeforeDispatch();
    const event = prepareEventPublish(this.nodeId, request);
    const admitted = this.waiting.acquire();
    if (admitted.outcome === 'refused') {
      return rejectedEventAck(
        capacityRefusal(
          admitted.reason === 'global-rate'
            ? 'node publish rate limit reached'
            : 'node pending publish wait limit reached',
          admitted.retryAfterMs ?? null,
        ),
      );
    }
    // Local subscribers hear an event once the NODE has admitted it (pending and rate limits above):
    // a node refusal reaches nobody. What a broker decides afterwards does not gate this delivery —
    // local delivery exists so that a node's own readers never wait for a broker, and a refusal
    // from one broker says nothing about the others. The publisher is told the broker's answer;
    // the local readers have the event regardless.
    const reached = this.localBus.publish(event);
    try {
      const selected = await this.selector.selectConnected(this.admission.publishAckTimeoutMs, signal);
      if (selected.state === 'aborted') return withdrawnBeforeDispatch();
      if (selected.state === 'selected') {
        return firstAcceptedPublish(
          selected.lanes.map((lane) => lane.publishEvent(event, signal)),
          signal,
        );
      }
      const detail =
        reached === 0
          ? 'no broker lane connected before publish dispatch deadline'
          : `no broker lane connected before publish dispatch deadline; delivered to ${reached} local subscriber(s)`;
      return rejectedEventAck(transportFailure(selected.cause, detail));
    } finally {
      admitted.lease.release();
    }
  }

  stopAdmission(): void {
    this.waiting.stopAdmission();
  }

  async drain(): Promise<void> {
    await this.waiting.drain();
  }

  get pending(): number {
    return this.waiting.getSnapshot().active;
  }
}
