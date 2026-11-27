import { EventEmitter } from 'node:events';
import { Decoder as SocketDecoder, Encoder as SocketEncoder, type Packet } from 'socket.io-parser';
import { MAX_FRAME_BYTES } from '../../../contracts/src/protocol/bounds.ts';
import { createLaneCodec, laneFrameFacts, recordLaneFrameFacts, type LanePacket } from './lane-codec.ts';

const MAX_HEADER_BYTES = 4096;

/** Standard Socket.IO identity/ACK envelope, one compressed binary attachment per data packet. */
export function createLaneParser(maxFrameBytes = MAX_FRAME_BYTES) {
  const codec = createLaneCodec(maxFrameBytes);
  class Encoder {
    private readonly socket = new SocketEncoder();
    private readonly body = new codec.Encoder();
    encode(packet: Packet): Array<string | Buffer> {
      if (packet.type !== 2 && packet.type !== 3) {
        const encoded: unknown[] = this.socket.encode(packet);
        if (!encoded.every((part): part is string => typeof part === 'string'))
          throw new Error('unexpected control attachment');
        return encoded;
      }
      const [frame] = this.body.encode(packet);
      if (frame === undefined) throw new Error('missing lane body');
      const data: unknown = packet.data;
      const wrapped = {
        ...packet,
        data: packet.type === 2 && Array.isArray(data) ? [data[0], frame] : [frame],
      };
      const parts: unknown[] = this.socket.encode(wrapped);
      const [header, binary] = parts;
      if (typeof header !== 'string' || binary !== frame || parts.length !== 2)
        throw new Error('invalid lane attachment encoding');
      const facts = laneFrameFacts(frame);
      if (facts === undefined) throw new Error('missing lane encoding facts');
      recordLaneFrameFacts(frame, { ...facts, encodedBytes: Buffer.byteLength(header) + frame.length });
      return [header, frame];
    }
  }
  class Decoder extends EventEmitter<{ decoded: [LanePacket | Packet] }> {
    private readonly socket = new SocketDecoder({ maxAttachments: 1 });
    private readonly body = new codec.Decoder();
    private headerBytes = 0;
    private input: unknown;
    constructor() {
      super();
      this.socket.on('decoded', (packet) => {
        if (packet.type !== 2 && packet.type !== 3) {
          this.emit('decoded', packet);
          return;
        }
        const data: unknown = packet.data;
        if (!Array.isArray(data)) throw new Error('missing lane attachment');
        const frame: unknown = data[packet.type === 2 ? 1 : 0];
        let decoded: LanePacket | undefined;
        const receive = (value: LanePacket) => {
          decoded = value;
        };
        this.body.once('decoded', receive);
        try {
          this.body.add(frame);
        } finally {
          this.body.off('decoded', receive);
        }
        if (
          decoded === undefined ||
          decoded.type !== packet.type ||
          decoded.id !== packet.id ||
          decoded.nsp !== packet.nsp ||
          (packet.type === 2 && (!Array.isArray(decoded.data) || decoded.data[0] !== data[0]))
        )
          throw new Error('lane attachment identity mismatch');
        const facts = laneFrameFacts(frame);
        if (facts === undefined || typeof this.input !== 'object' || this.input === null)
          throw new Error('missing lane decoding facts');
        recordLaneFrameFacts(this.input, { ...facts, encodedBytes: facts.encodedBytes + this.headerBytes });
        this.emit('decoded', decoded);
      });
    }
    add(input: unknown): void {
      if (typeof input === 'string') {
        this.headerBytes = Buffer.byteLength(input);
        if (this.headerBytes > MAX_HEADER_BYTES) throw new Error('lane header exceeds byte limit');
      }
      this.input = input;
      try {
        this.socket.add(input);
      } finally {
        this.input = undefined;
      }
    }
    destroy(): void {
      this.socket.destroy();
      this.body.destroy();
      this.headerBytes = 0;
    }
  }
  return { protocol: 5, Encoder, Decoder };
}
export const laneParser = createLaneParser();
