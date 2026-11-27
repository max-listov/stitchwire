import { StreamAckSchema, type StreamAck } from '../../../contracts/src/protocol/stream.ts';
import { LANE_ACK_TIMEOUT_MS } from './lane-contract.ts';

/** One bounded stream acknowledgement. Offline dispatch and timeout settle once, late acks are ignored. */
export function laneStreamAck(
  emit: (resolve: (ack: StreamAck) => void) => boolean,
  timeoutMs = LANE_ACK_TIMEOUT_MS,
): Promise<StreamAck> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ack: StreamAck): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ack);
    };
    const timer = setTimeout(
      () => settle(StreamAckSchema.parse({ ok: false, detail: 'broker stream acknowledgement timed out' })),
      timeoutMs,
    );
    if (!emit(settle)) settle(StreamAckSchema.parse({ ok: false, detail: 'not connected to the broker' }));
  });
}
