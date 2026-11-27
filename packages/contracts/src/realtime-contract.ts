import { defineRealtimeContract } from 'stitchkit';
import { z } from 'zod';
import { MAX_NODES } from './protocol/bounds.ts';
import { PeerEchoSchema, PeerProbeSchema, PeerReplySchema } from './peer-contract.ts';
import { ServiceDeclareAckSchema, ServiceDeclareSchema } from './service/declaration.ts';
import {
  FleetOfferSchema,
  FleetPublishAckSchema,
  FleetPublishSchema,
  FleetSyncAckSchema,
  FleetSyncSchema,
} from './fleet/bundle.ts';
import {
  EventAckSchema,
  EventDeliveryAckSchema,
  EventErrorSchema,
  EventFrameSchema,
  EventGapSchema,
  EventPublishSchema,
  EventSubscribeSchema,
  EventUnsubscribeSchema,
} from './protocol/event.ts';
import { AdmissionSchema, CancelSchema, InvocationSchema, ResultSchema } from './protocol/rpc.ts';
import { PresenceSchema } from './protocol/presence.ts';
import {
  StreamAckSchema,
  StreamAdmissionSchema,
  StreamCancelSchema,
  StreamChunkSchema,
  StreamEndSchema,
  StreamErrorSchema,
  StreamInvokeSchema,
  StreamOpenSchema,
  StreamWindowSchema,
} from './protocol/stream.ts';
import { EventDeclareAckSchema, EventDeclareSchema } from './protocol/topic.ts';
import { ServiceCancelSchema, ServiceResultSchema, ServiceRouteSchema } from './service/contracts.ts';

export const wireContract = defineRealtimeContract({
  serverToClient: {
    'service:invoke': { args: z.tuple([ServiceRouteSchema]) },
    'service:result': { args: z.tuple([ServiceResultSchema]) },
    'service:cancel': { args: z.tuple([ServiceCancelSchema]) },
    'peer:echo': { args: z.tuple([PeerEchoSchema]) },
    'peer:result': { args: z.tuple([PeerReplySchema]) },
    /** Broker → the node that must run it. */
    'rpc:invoke': { args: z.tuple([InvocationSchema]) },
    /** Broker → the node that asked. */
    'rpc:result': { args: z.tuple([ResultSchema]) },
    /** Broker → the node running it: the caller withdrew. */
    'rpc:cancel': { args: z.tuple([CancelSchema]) },
    /** Broker → everyone: a node arrived or left. */
    'node:presence': { args: z.tuple([PresenceSchema]) },
    'stream:invoke': { args: z.tuple([StreamInvokeSchema]) },
    'stream:chunk': { args: z.tuple([StreamChunkSchema]) },
    'stream:window': { args: z.tuple([StreamWindowSchema]) },
    'stream:cancel': { args: z.tuple([StreamCancelSchema]) },
    'stream:end': { args: z.tuple([StreamEndSchema]) },
    'stream:error': { args: z.tuple([StreamErrorSchema]) },
    'event:event': { args: z.tuple([EventFrameSchema]), ack: EventDeliveryAckSchema },
    'event:gap': { args: z.tuple([EventGapSchema]), ack: EventDeliveryAckSchema },
    'event:error': { args: z.tuple([EventErrorSchema]), ack: EventDeliveryAckSchema },
    /** Broker → every node: a newer fleet bundle is kept here. */
    'fleet:offer': { args: z.tuple([FleetOfferSchema]) },
  },
  clientToServer: {
    'service:call': { args: z.tuple([ServiceRouteSchema]) },
    'service:result': { args: z.tuple([ServiceResultSchema]) },
    'service:cancel': { args: z.tuple([ServiceCancelSchema]) },
    'peer:probe': { args: z.tuple([PeerProbeSchema]) },
    'peer:echo': { args: z.tuple([PeerEchoSchema]) },
    /** Caller → broker. The ack is admission only. */
    'rpc:call': { args: z.tuple([InvocationSchema]), ack: AdmissionSchema },
    /** Executor → broker, to be routed back to the caller. */
    'rpc:result': { args: z.tuple([ResultSchema]), ack: z.object({ ok: z.boolean() }).strict() },
    /** Caller → broker: stop waiting, and stop the work. */
    'rpc:cancel': { args: z.tuple([CancelSchema]) },
    /** Anyone → broker: who is on the wire right now. */
    'nodes:list': { args: z.tuple([]), ack: z.array(PresenceSchema).max(MAX_NODES) },
    'stream:open': { args: z.tuple([StreamOpenSchema]), ack: StreamAdmissionSchema },
    'stream:chunk': { args: z.tuple([StreamChunkSchema]), ack: StreamAckSchema },
    'stream:window': { args: z.tuple([StreamWindowSchema]), ack: StreamAckSchema },
    'stream:cancel': { args: z.tuple([StreamCancelSchema]), ack: StreamAckSchema },
    'stream:end': { args: z.tuple([StreamEndSchema]), ack: StreamAckSchema },
    'stream:error': { args: z.tuple([StreamErrorSchema]), ack: StreamAckSchema },
    'event:subscribe': { args: z.tuple([EventSubscribeSchema]), ack: EventAckSchema },
    'event:unsubscribe': { args: z.tuple([EventUnsubscribeSchema]), ack: EventAckSchema },
    'event:publish': { args: z.tuple([EventPublishSchema]), ack: EventAckSchema },
    /** Producer → broker: the complete set of topics its owner declares, sent on every connect. */
    'event:declare': { args: z.tuple([EventDeclareSchema]), ack: EventDeclareAckSchema },
    /** Serving node → broker: the complete set of grants to call it that its owners declare. */
    'service:declare': { args: z.tuple([ServiceDeclareSchema]), ack: ServiceDeclareAckSchema },
    /** Node → broker, on connect and on offer: the fleet bundle edition it keeps. */
    'fleet:sync': { args: z.tuple([FleetSyncSchema]), ack: FleetSyncAckSchema },
    /** Any node → broker: a complete signed fleet bundle to keep and hand on. */
    'fleet:publish': { args: z.tuple([FleetPublishSchema]), ack: FleetPublishAckSchema },
  },
});
