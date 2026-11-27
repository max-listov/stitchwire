import type {
  LocalCall,
  LocalEventPublish,
  LocalEventSubscribe,
  LocalStreamRequest,
} from '../../../contracts/src/door/requests.ts';
import type { LocalStatus } from '../../../contracts/src/door/status.ts';
import type { PeerObservation, PeerOutcome, PeerRequest } from '../../../contracts/src/peer-contract.ts';
import type { EventAck, EventPublish } from '../../../contracts/src/protocol/event.ts';
import type { Result } from '../../../contracts/src/protocol/rpc.ts';
import type { EventDeclare, EventDeclareAck } from '../../../contracts/src/protocol/topic.ts';
import type { ServiceDeclare, ServiceDeclareAck } from '../../../contracts/src/service/declaration.ts';
import type { ServiceCall, ServiceOutcome } from '../../../contracts/src/service/contracts.ts';
import type { FleetBundle, FleetPublishAck, FleetSyncAck } from '../../../contracts/src/fleet/bundle.ts';
import type { EventDelivery } from './event-consumer.ts';
import type { LanePresence } from './lane-routing.ts';
import type { StreamConsumerEvent } from './stream-consumer.ts';

export type AgentStatus = Omit<LocalStatus, 'application' | 'publicationAudit' | 'serviceAudit'>;

export interface Agent {
  invokeService(req: ServiceCall, signal?: AbortSignal): Promise<ServiceOutcome>;
  observePeer(req: PeerRequest): Promise<PeerObservation>;
  call(req: LocalCall, signal?: AbortSignal): Promise<Result>;
  openStream(req: LocalStreamRequest): AsyncIterableIterator<StreamConsumerEvent>;
  publishEvent(req: LocalEventPublish, signal?: AbortSignal): Promise<EventAck>;
  subscribeEvents(req: LocalEventSubscribe): AsyncIterableIterator<EventDelivery>;
  status(): Promise<AgentStatus>;
  /**
   * End every long-lived answer this agent is currently giving a local neighbour, without touching
   * the broker lanes.
   *
   * The door's NDJSON responses only finish when their source iterator does, and that source is
   * here. Closing the lanes first would end them too — but then a local caller arriving in between
   * is told the transport failed, when the truth is the agent is going away. Draining first and
   * closing after is the difference, and it is why this is separate from `stop`.
   */
  drainLocal(): Promise<void>;
  stop(): Promise<void>;
  readonly connected: boolean;
}

export type LaneAgent = Omit<Agent, 'observePeer' | 'publishEvent'> & {
  publishEvent(event: EventPublish, signal?: AbortSignal): Promise<EventAck>;
  presence: LanePresence;
  readonly terminal: boolean;
  probePeer(to: string): Promise<PeerOutcome>;
  /** Tell this lane's broker the complete set of owner-declared topics; null when not answered. */
  declareTopics(request: EventDeclare): Promise<EventDeclareAck | null>;
  /** Tell this lane's broker the complete set of owner-declared service grants; null when not answered. */
  declareServices(request: ServiceDeclare): Promise<ServiceDeclareAck | null>;
  /** Tell this lane's broker which fleet bundle edition this node keeps; null when not answered. */
  syncFleet(serial: number | null): Promise<FleetSyncAck | null>;
  /** Hand this lane's broker a complete fleet bundle; null when not answered. */
  publishFleet(bundle: FleetBundle): Promise<FleetPublishAck | null>;
  /** Called with each newer edition the broker says it keeps. */
  onFleetOffer(listener: (serial: number) => void): void;
};

export interface ConfigOrigin {
  path: string;
}

/** How many of this node's lanes are up, out of how many it declared. */
export interface LaneHealth {
  connected: number;
  total: number;
}

export interface AgentHandle extends Agent {
  socketPath: string;
}
