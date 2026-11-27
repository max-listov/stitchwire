import { bindRealtimeServer, createSocketIOServer } from 'stitchkit/server';
import { HandshakeSchema } from '../../../contracts/src/protocol/rpc.ts';
import { wireContract } from '../../../contracts/src/realtime-contract.ts';
import type { BrokerConfig } from '../config/broker.ts';
import { wireLogger } from '../logger.ts';
import { LANE_FRAME_HEADER_BYTES } from '../transport/lane-codec.ts';
import { createLaneParser } from '../transport/lane-parser.ts';
import type { Audit } from './audit.ts';
import { admitNode, type StrandedNodes } from './handshake.ts';
import type { Registry } from './registry.ts';

/**
 * The broker's socket: who may connect (the handshake admits only registered nodes), how large a
 * frame may be, and what happens to a payload that breaks its contract. Everything a node can say
 * is then typed by `wireContract`; routing the decisions is the connection's business.
 */
export async function openWireSocket(
  config: BrokerConfig,
  registry: Registry,
  stranded: StrandedNodes,
  audit: Audit,
) {
  const socket = await createSocketIOServer({
    /** The standalone artifact carries the Socket.IO peers it loads at runtime. */
    peers: {
      server: () => import('socket.io'),
      bunEngine: () => import('@socket.io/bun-engine'),
    },
    // No browser ever opens this socket — every client is a CLI process on a machine we own — so
    // there is no origin to allow. An empty list is the honest expression of that, not a gap.
    cors: { origin: [] },
    serverOptions: {
      // Socket.IO defaults to a 1 MB frame. A legitimate answer — a long transcript — is bigger than
      // that, and the default failure mode is a dropped connection rather than an error, so the limit
      // is lifted on both ends and the truncation decision is made explicitly by the executor instead.
      maxHttpBufferSize: config.admission.maxFrameBytes + LANE_FRAME_HEADER_BYTES,
      parser: createLaneParser(config.admission.maxFrameBytes),
    },
    handshake: { schema: HandshakeSchema, verify: admitNode(registry, audit, stranded) },
  });

  const realtime = bindRealtimeServer(wireContract, socket, {
    onRejected: (event) => {
      // A payload that fails its own schema is a version mismatch or a forgery attempt. Either way
      // it is worth a line: silently dropping it is how a fleet-wide skew stays invisible for days.
      wireLogger.error('[wire] realtime event rejected', {
        direction: event.direction,
        event: event.event,
        error: event.error,
      });
      audit.write({
        kind: 'protocol-rejected',
        direction: event.direction,
        event: String(event.event),
      });
    },
  });
  return { socket, realtime };
}
