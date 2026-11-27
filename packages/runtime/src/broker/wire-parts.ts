import { createBoundedAdmission } from 'stitchkit/application';
import { FleetOfferSchema } from '../../../contracts/src/fleet/bundle.ts';
import { CancelSchema, ResultSchema } from '../../../contracts/src/protocol/rpc.ts';
import type { BrokerConfig } from '../config/broker.ts';
import type { SelfReload } from '../fleet/reconcile.ts';
import { ServiceRouter } from '../service/broker.ts';
import { ServiceGrantRegistry } from '../service/grant-registry.ts';
import type { Audit } from './audit.ts';
import { CommandRouter } from './commands.ts';
import { EventRouter, type EventSink } from './events.ts';
import { FleetKeeper } from './fleet-keeper.ts';
import { PeerProbes } from './peer-probes.ts';
import type { Registry } from './registry.ts';
import { serviceSink, streamSink, type WireRealtime } from './sinks.ts';
import { StreamRouter } from './streams.ts';

type EventDelivery = Parameters<EventSink['deliver']>[1];
type EventAcknowledge = Parameters<EventSink['deliver']>[2];

/** The socket a node's event deliveries leave through, registered while that node is connected. */
type EventDeliveryTarget = (delivery: EventDelivery, acknowledge: EventAcknowledge) => void;

/**
 * Every router and keeper the wire is made of, each given the sink that owns its socket. The
 * routers decide; the connection (`wire-connection.ts`) only hands them what a node said.
 */
export function createWireParts(input: {
  config: BrokerConfig;
  registry: Registry;
  realtime: WireRealtime;
  audit: Audit;
  configPath: string | undefined;
  reload: SelfReload | undefined;
}) {
  const { config, registry, realtime, audit } = input;

  /** One bounded admission keyed by the finite authenticated roster. */
  const declaredNodes = Math.max(1, config.nodes.length);
  const calls = createBoundedAdmission({
    policy: {
      // The global ceiling is the maximum aggregate permitted by the per-node roster bounds.
      global: {
        maxConcurrent: config.admission.maxInflightPerNode * declaredNodes,
        rate: {
          limit: config.admission.maxCallsPerMinutePerNode * declaredNodes,
          intervalMs: 60_000,
        },
      },
      perKey: {
        maxKeys: declaredNodes,
        maxConcurrent: config.admission.maxInflightPerNode,
        rate: { limit: config.admission.maxCallsPerMinutePerNode, intervalMs: 60_000 },
      },
    },
  });

  const peers = new PeerProbes((socketId, event, reply) => {
    if (event === 'echo') realtime.to(socketId).emit('peer:echo', { id: reply.id });
    else realtime.to(socketId).emit('peer:result', reply);
  });

  const streams = new StreamRouter(config.admission, streamSink(realtime, audit), declaredNodes);

  const eventTargets = new Map<string, EventDeliveryTarget>();
  const eventsRouter = new EventRouter(config, {
    deliver: (socketId, delivery, acknowledge) => {
      const target = eventTargets.get(socketId);
      if (target === undefined) {
        acknowledge({ accepted: false, refusal: 'none', detail: 'subscriber socket is gone' });
      } else target(delivery, acknowledge);
    },
  });

  const commands = new CommandRouter(audit, {
    cancel: (socketId, cancel) => realtime.to(socketId).emit('rpc:cancel', CancelSchema.parse(cancel)),
    result: (socketId, result) => realtime.to(socketId).emit('rpc:result', ResultSchema.parse(result)),
  });

  const fleet = new FleetKeeper(
    config.fleet,
    config,
    input.configPath,
    input.reload,
    (event) => audit.write(event),
    (serial) => realtime.emit('fleet:offer', FleetOfferSchema.parse({ serial })),
  );
  fleet.start();

  const serviceGrants = new ServiceGrantRegistry(config);
  const serviceRouter = new ServiceRouter(
    () => serviceGrants.grants(),
    serviceSink(realtime, audit, registry),
  );

  return {
    calls,
    peers,
    streams,
    eventTargets,
    eventsRouter,
    commands,
    fleet,
    serviceGrants,
    serviceRouter,
    /** The wire's stop-admission step: every router and keeper stops taking work. */
    stopAdmission(): void {
      fleet.stop();
      serviceRouter.stop();
      calls.stopAdmission();
      commands.stop();
      streams.stop();
      eventsRouter.stop();
      peers.stop();
    },
  };
}

export type WireParts = ReturnType<typeof createWireParts>;
