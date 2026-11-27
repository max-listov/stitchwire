import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { createLaneCodec, laneFrameFacts, laneCodec } from '../packages/runtime/src/transport/lane-codec.ts';
import {
  LaneVolumeMeter,
  laneVolumeRows,
  type LaneVolumeRow,
} from '../packages/runtime/src/transport/lane-volume.ts';

function frameFor(packet: unknown, parser = laneCodec): Buffer {
  const [frame] = new parser.Encoder().encode(packet);
  if (frame === undefined) throw new Error('encoder returned no frame');
  return frame;
}
function unpack(frame: unknown, parser = laneCodec): unknown {
  let result: unknown;
  const decoder = new parser.Decoder();
  decoder.on('decoded', (packet) => {
    result = packet;
  });
  decoder.add(frame);
  return result;
}

test('binary body preserves quotes, backslashes, Unicode and empty JSON without re-escaping', () => {
  const payload = JSON.stringify({ quote: '"\\'.repeat(100), unicode: '猫🙂', empty: {} });
  const packet = { type: 2, nsp: '/', data: ['service:result', { id: 'id', payload }] };
  const frame = frameFor(packet);
  expect(unpack(frame)).toEqual(packet);
  expect(laneFrameFacts(frame)?.decodedBytes).toBeLessThan(Buffer.byteLength(payload) + 80);
  expect(unpack(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength))).toEqual(packet);
});

test('incompressible bytes and small control packets use identity, with one fixed header', () => {
  for (const packet of [
    { type: 2, nsp: '/', data: ['binary', randomBytes(8192)] },
    { type: 0, nsp: '/', data: { sid: 'session' } },
    { type: 3, nsp: '/', id: 0, data: [{ ok: true }] },
    { type: 1, nsp: '/' },
    { type: 4, nsp: '/', data: { message: 'refused' } },
  ]) {
    const frame = frameFor(packet);
    expect(frame[3]).toBe(0);
    expect(frame.length).toBe(frame.readUInt32BE(4) + 8);
    expect(unpack(frame)).toEqual(packet);
  }
});

test('decoded ceiling admits exact size and rejects one extra byte even after compression', () => {
  const packet = { type: 2, nsp: '/', data: ['value', 'x'.repeat(4000)] };
  const frame = frameFor(packet);
  const length = frame.readUInt32BE(4);
  expect(unpack(frame, createLaneCodec(length))).toEqual(packet);
  expect(() => unpack(frame, createLaneCodec(length - 1))).toThrow('decoded byte limit');
  expect(() => frameFor(packet, createLaneCodec(length - 1))).toThrow('decoded byte limit');
});

test('event and stream binary bodies avoid base64 inflation and restore byte-exact contract values', () => {
  const bytes = randomBytes(4000);
  for (const event of ['event:publish', 'event:event', 'stream:chunk']) {
    const packet = {
      type: 2,
      nsp: '/',
      data: [event, { encoding: 'base64', data: bytes.toString('base64'), bytes: bytes.length }],
    };
    const frame = frameFor(packet);
    expect(unpack(frame)).toEqual(packet);
    expect(frame.length).toBeLessThan(bytes.length + 100);
  }
});

test('codec rejects skew, malformed packets, truncated data, false lengths and compression bombs', () => {
  const valid = frameFor({ type: 2, nsp: '/', data: ['value', 'x'.repeat(4000)] });
  const skew = Buffer.from(valid);
  skew[2] = 2;
  expect(() => unpack(skew)).toThrow('unsupported lane codec');
  expect(() => unpack('42["event",{}]')).toThrow('binary frame');
  expect(() => unpack(valid.subarray(0, 7))).toThrow('binary frame');
  const mismatch = frameFor({ type: 1, nsp: '/' });
  mismatch.writeUInt32BE(mismatch.readUInt32BE(4) + 1, 4);
  expect(() => unpack(mismatch)).toThrow('length mismatch');
  const bomb = Buffer.concat([valid.subarray(0, 8), zstdCompressSync(Buffer.alloc(1024 * 1024))]);
  bomb.writeUInt32BE(64, 4);
  expect(() => unpack(bomb)).toThrow();
  expect(() => frameFor({ type: 2, nsp: '/', data: ['disconnect'] })).toThrow('invalid lane packet');
  expect(() => frameFor({ type: 3, nsp: '/', data: 'not an ack' })).toThrow('invalid lane packet');
});

test('independent frames survive decoder recreation and preserve packet order', () => {
  const encoder = new laneCodec.Encoder();
  const decoder = new laneCodec.Decoder();
  const seen: unknown[] = [];
  decoder.on('decoded', (packet) => seen.push(packet));
  for (let id = 0; id < 30; id++) {
    const packet = { type: 2, nsp: '/', id, data: ['value', 'abc'.repeat(1000)] };
    const [frame] = encoder.encode(packet);
    decoder.add(frame);
    expect(unpack(frame)).toEqual(packet);
  }
  expect(seen).toHaveLength(30);
});

test('meter attributes both response legs, counts actual packet bytes and flushes without content', () => {
  const rows: LaneVolumeRow[] = [];
  const meter = new LaneVolumeMeter((batch) => rows.push(...laneVolumeRows(batch)));
  meter.record(
    'reader',
    'reader',
    'in',
    frameFor({
      type: 2,
      nsp: '/',
      data: ['service:call', { id: 'call', service: 'example.data', payload: '{}' }],
    }),
  );
  meter.record(
    'worker',
    'worker',
    'out',
    frameFor({
      type: 2,
      nsp: '/',
      data: ['service:invoke', { id: 'call', service: 'example.data', payload: '{}' }],
    }),
  );
  const response = frameFor({
    type: 2,
    nsp: '/',
    data: ['service:result', { id: 'call', payload: 'private-content'.repeat(1000) }],
  });
  meter.record('worker', 'worker', 'in', response);
  meter.record('reader', 'reader', 'out', response);
  meter.flush();
  const responseRows = rows.filter((row) => row.event === 'service:result');
  expect(responseRows).toHaveLength(2);
  for (const row of responseRows) {
    expect(row.service).toBe('example.data');
    expect(row.encodedBytes).toBe(response.length);
    expect(row.compressedFrames).toBe(1);
  }
  expect(JSON.stringify(rows)).not.toContain('private-content');
  const count = rows.length;
  meter.flush();
  expect(rows).toHaveLength(count);
});
