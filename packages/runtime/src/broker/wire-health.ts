import { implement } from 'stitchkit/server';
import type { BrokerConfig } from '../config/broker.ts';
import type { Audit } from './audit.ts';
import type { ApplicationStatus } from '../../../contracts/src/door/status.ts';
import { healthContract } from './contracts.ts';
import type * as fleetHealth from './health.ts';
import type { Presence } from '../../../contracts/src/protocol/presence.ts';
import type { Registry } from './registry.ts';
import type { BrokerTransportObservation } from './transport-observation.ts';
import type { WireParts } from './wire-parts.ts';

/** The broker's own health answer: the roster, the planes' occupancy and the limits they run under. */
export function healthService(input: {
  config: BrokerConfig;
  registry: Registry;
  audit: Audit;
  parts: WireParts;
  transportObservation: BrokerTransportObservation;
  projection: () => ApplicationStatus;
  presence: () => Presence[];
  fleetStanding: () => ReturnType<typeof fleetHealth.fleetStanding>;
}) {
  const { config, registry, audit, parts, transportObservation, projection } = input;
  const { fleet, streams, eventsRouter } = parts;
  return implement(healthContract, {
    get: () => ({
      ok: audit.status().writeFailures === 0 && audit.status().dropped === 0,
      nodes: input.presence(),
      observingSince: registry.observingSince,
      transport: transportObservation.snapshot(),
      fleet: input.fleetStanding(),
      application: projection(),
      bundle: fleet.health(),
      audit: audit.status(),
      streams: streams.status(),
      events: { ...eventsRouter.status(), recent: eventsRouter.admissions(5, Date.now()) },
      topics: eventsRouter.topics(Date.now()),
      admission: {
        maxInflightPerNode: config.admission.maxInflightPerNode,
        maxCallsPerMinutePerNode: config.admission.maxCallsPerMinutePerNode,
        maxStreamsTotal: config.admission.maxStreamsTotal,
        maxStreamsPerCaller: config.admission.maxStreamsPerCaller,
        maxStreamsPerProducer: config.admission.maxStreamsPerProducer,
        maxStreamOpensPerMinute: config.admission.maxStreamOpensPerMinute,
        maxEventSubscriptionsTotal: config.admission.maxEventSubscriptionsTotal,
        maxEventSubscribesPerMinute: config.admission.maxEventSubscribesPerMinute,
      },
    }),
  });
}
