import type { createRealtimeClient } from 'stitchkit';
import type { wireContract } from '../../../contracts/src/realtime-contract.ts';
import type { BrokerEndpoint, NodeConfig } from '../config/node.ts';

export const LANE_ACK_TIMEOUT_MS = 5_000;
export type LaneConfig = NodeConfig & BrokerEndpoint;
export type LaneClient = ReturnType<
  typeof createRealtimeClient<typeof wireContract.serverToClient, typeof wireContract.clientToServer>
>;
