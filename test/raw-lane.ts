import { createRealtimeClient } from 'stitchkit';
import { wireContract } from '../packages/contracts/src/realtime-contract.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';
import { loadLanePeer } from '../packages/runtime/src/transport/lane-peer.ts';
import { until } from './support.ts';

/**
 * A node that speaks the broker's wire directly, with none of the agent's own behaviour on top: it
 * sends exactly the frames a test hands it and acknowledges exactly the deliveries it is told to.
 * It is how a test plays a peer the agent would never be: a node that is neither end of a stream, or
 * a subscriber that never acknowledges.
 */
export type RawLane = Awaited<ReturnType<typeof rawLane>>;

/** The ceiling of one request on a raw lane: it bounds a hang, not a speed. */
export const RAW_REQUEST_TIMEOUT_MS = 10_000;

export async function rawLane(port: number, nodeId: string, token: string) {
  const client = createRealtimeClient(wireContract, {
    url: `http://127.0.0.1:${port}`,
    peers: { client: loadLanePeer },
    auth: () => ({ nodeId, token, serves: false, version: RELEASE_VERSION }),
    withCredentials: false,
    transports: ['websocket'],
  });
  client.connect();
  if (!(await until(() => client.connected))) throw new Error(`raw lane '${nodeId}' never connected`);
  return {
    client,
    close: (): void => {
      client.disconnect();
    },
  };
}
