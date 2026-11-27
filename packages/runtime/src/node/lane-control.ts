import type { EventDeclare } from '../../../contracts/src/protocol/topic.ts';
import type { ServiceDeclare } from '../../../contracts/src/service/declaration.ts';
import type { FleetBundle } from '../../../contracts/src/fleet/bundle.ts';
import { wireLogger } from '../logger.ts';
import { LANE_ACK_TIMEOUT_MS, type LaneClient } from './lane-contract.ts';

/** Declarations and signed fleet exchange share one bounded, nullable acknowledgement policy.
 * The realtime contract validates input and acknowledgements at the transport boundary. */
export function createLaneControl(client: LaneClient, lane: string, ackTimeoutMs = LANE_ACK_TIMEOUT_MS) {
  const request = async <Value>(send: () => Promise<Value>, subject: string): Promise<Value | null> => {
    if (!client.connected) return null;
    try {
      return await send();
    } catch (error) {
      wireLogger.error(`[wire] ${subject} was not answered`, { lane, error });
      return null;
    }
  };
  let fleetOffer: (serial: number) => void = () => {};
  client.on('fleet:offer', (offer) => fleetOffer(offer.serial));
  return {
    declareTopics: (value: EventDeclare) =>
      request(() => client.request('event:declare', value, { timeoutMs: ackTimeoutMs }), 'topic declaration'),
    declareServices: (value: ServiceDeclare) =>
      request(
        () => client.request('service:declare', value, { timeoutMs: ackTimeoutMs }),
        'service declaration',
      ),
    syncFleet: (serial: number | null) =>
      request(
        () => client.request('fleet:sync', { serial }, { timeoutMs: ackTimeoutMs }),
        'fleet bundle sync',
      ),
    publishFleet: (bundle: FleetBundle) =>
      request(
        () => client.request('fleet:publish', { bundle }, { timeoutMs: ackTimeoutMs }),
        'fleet bundle publication',
      ),
    onFleetOffer: (listener: (serial: number) => void): void => {
      fleetOffer = listener;
    },
  };
}
