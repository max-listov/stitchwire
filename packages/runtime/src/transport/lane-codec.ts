import { EventEmitter } from 'node:events';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { Decoder as MessageDecoder, Encoder as MessageEncoder } from '@msgpack/msgpack';
import { z } from 'zod';
import { MAX_FRAME_BYTES } from '../../../contracts/src/protocol/bounds.ts';

export const LANE_FRAME_HEADER_BYTES = 8;
const MAGIC = Buffer.from([0x53, 0x57, 1]);
const COMPRESSION_THRESHOLD = 1024;

const PacketSchema = z.object({
  type: z.number().int().min(0).max(4),
  nsp: z.literal('/'),
  id: z.number().int().nonnegative().optional(),
  data: z.unknown().optional(),
});
export type LanePacket = z.infer<typeof PacketSchema>;
const RESERVED = new Set([
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
]);
const BINARY_BODY_EVENTS = new Set(['event:publish', 'event:event', 'stream:chunk']);

/** Base64 is the JSON door representation; the binary lane carries the original bytes. */
function binaryBody(packet: LanePacket, direction: 'encode' | 'decode'): LanePacket {
  if (packet.type !== 2 || !Array.isArray(packet.data)) return packet;
  const [event, payload, ...rest] = packet.data;
  if (
    typeof event !== 'string' ||
    !BINARY_BODY_EVENTS.has(event) ||
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    Reflect.get(payload, 'encoding') !== 'base64'
  )
    return packet;
  const data: unknown = Reflect.get(payload, 'data');
  const converted =
    direction === 'encode' && typeof data === 'string'
      ? Buffer.from(data, 'base64')
      : direction === 'decode' && data instanceof Uint8Array
        ? Buffer.from(data).toString('base64')
        : null;
  if (converted === null) return packet;
  return { ...packet, data: [event, { ...payload, data: converted }, ...rest] };
}

function validatePacket(value: unknown): LanePacket {
  const packet = PacketSchema.parse(value);
  const data = packet.data;
  const record = typeof data === 'object' && data !== null && !Array.isArray(data);
  const valid =
    packet.type === 0
      ? data === undefined || record
      : packet.type === 1
        ? data === undefined
        : packet.type === 2
          ? Array.isArray(data) && typeof data[0] === 'string' && !RESERVED.has(data[0])
          : packet.type === 3
            ? Array.isArray(data)
            : typeof data === 'string' || record;
  if (!valid) throw new Error('invalid lane packet');
  return packet;
}

export interface LaneFrameFacts {
  packet: LanePacket;
  encodedBytes: number;
  decodedBytes: number;
  compressed: boolean;
}
/** Shared buffers can be broadcast to several connections without retaining packet history. */
const frameFacts = new WeakMap<object, LaneFrameFacts>();
export function laneFrameFacts(frame: unknown): LaneFrameFacts | undefined {
  return typeof frame === 'object' && frame !== null ? frameFacts.get(frame) : undefined;
}
export function recordLaneFrameFacts(frame: object, facts: LaneFrameFacts): void {
  frameFacts.set(frame, facts);
}

/** One binary Engine.IO message per packet; MessagePack strings never re-escape owner JSON. */
export function createLaneCodec(maxFrameBytes = MAX_FRAME_BYTES) {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > MAX_FRAME_BYTES)
    throw new Error('invalid lane frame bound');
  class Encoder {
    private readonly encoder = new MessageEncoder({ maxDepth: 64, ignoreUndefined: true });
    encode(input: unknown): Buffer[] {
      const packet = validatePacket(input);
      const plain = this.encoder.encodeSharedRef(binaryBody(packet, 'encode'));
      if (plain.byteLength > maxFrameBytes) throw new Error('lane frame exceeds decoded byte limit');
      const candidate =
        plain.byteLength >= COMPRESSION_THRESHOLD
          ? zstdCompressSync(plain, { params: { [constants.ZSTD_c_compressionLevel]: 1 } })
          : plain;
      const compressed = candidate.byteLength < plain.byteLength;
      const body = compressed ? candidate : plain;
      const frame = Buffer.allocUnsafe(LANE_FRAME_HEADER_BYTES + body.byteLength);
      frame.set(MAGIC);
      frame[3] = compressed ? 1 : 0;
      frame.writeUInt32BE(plain.byteLength, 4);
      frame.set(body, LANE_FRAME_HEADER_BYTES);
      frameFacts.set(frame, {
        packet,
        encodedBytes: frame.byteLength,
        decodedBytes: plain.byteLength,
        compressed,
      });
      return [frame];
    }
  }
  class Decoder extends EventEmitter<{ decoded: [LanePacket] }> {
    private readonly decoder = new MessageDecoder({
      maxStrLength: maxFrameBytes,
      maxBinLength: maxFrameBytes,
      maxArrayLength: 65536,
      maxMapLength: 65536,
      maxExtLength: 0,
    });
    add(input: unknown): void {
      const frame =
        input instanceof Uint8Array
          ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
          : input instanceof ArrayBuffer
            ? Buffer.from(input)
            : null;
      if (
        frame === null ||
        frame.byteLength < LANE_FRAME_HEADER_BYTES ||
        frame.byteLength > maxFrameBytes + LANE_FRAME_HEADER_BYTES
      )
        throw new Error('invalid lane binary frame');
      if (!frame.subarray(0, 3).equals(MAGIC) || (frame[3] !== 0 && frame[3] !== 1))
        throw new Error('unsupported lane codec');
      const decodedBytes = frame.readUInt32BE(4);
      if (decodedBytes === 0 || decodedBytes > maxFrameBytes)
        throw new Error('lane frame exceeds decoded byte limit');
      const compressed = frame[3] === 1;
      const body = frame.subarray(LANE_FRAME_HEADER_BYTES);
      const plain = compressed
        ? zstdDecompressSync(body, {
            maxOutputLength: decodedBytes,
            params: { [constants.ZSTD_d_windowLogMax]: Math.max(10, Math.ceil(Math.log2(maxFrameBytes))) },
          })
        : body;
      if (plain.byteLength !== decodedBytes) throw new Error('lane frame length mismatch');
      const packet = binaryBody(validatePacket(this.decoder.decode(plain)), 'decode');
      if (typeof input === 'object' && input !== null)
        frameFacts.set(input, { packet, encodedBytes: frame.byteLength, decodedBytes, compressed });
      this.emit('decoded', packet);
    }
    destroy(): void {
      // Every packet is self-contained; no partial attachments or compression dictionary survive.
    }
  }
  return { protocol: 5, Encoder, Decoder };
}

export const laneCodec = createLaneCodec();
