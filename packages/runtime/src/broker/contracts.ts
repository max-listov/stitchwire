/**
 * The broker authenticates nodes, enforces admission and routes calls, streams and events.
 * It never executes commands. Event bodies may remain in bounded volatile retention;
 * durable history and domain reconciliation belong to the service owner.
 * The credential registry stores digests; the trusted broker sees authentication tokens
 * and routed payloads in memory.
 *
 * It listens on loopback. TLS and the public edge belong to the reverse proxy in front of it — the
 * one already renewing certificates for everything else on that machine.
 */

import { defineContract } from 'stitchkit';
import type { ApplicationShutdownOptions, ApplicationShutdownResult } from 'stitchkit/application';
import {
  BrokerHealthContractSchema,
  type EventLoopDelaySnapshot,
  type TransportObservationSnapshot,
} from '../../../contracts/src/protocol/broker-health.ts';

export type { EventLoopDelaySnapshot, TransportObservationSnapshot };

/** The connection identity the handshake gate proves once; every handler reads it typed instead of
 *  re-deriving it from `String(raw.data.x)` casts. */
export interface WireIdentity {
  nodeId: string;
  serves: boolean;
  version: string;
}

export const healthContract = defineContract(
  { prefix: 'health' },
  {
    get: {
      method: 'GET',
      path: '/',
      desc: 'Broker liveness and the current node roster',
      output: BrokerHealthContractSchema,
    },
  },
);

export interface BrokerHandle {
  stop(options?: ApplicationShutdownOptions): Promise<ApplicationShutdownResult>;
  port: number;
}
