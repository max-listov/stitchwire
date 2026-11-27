import { expect, test } from 'bun:test';
import { laneParser } from '../packages/runtime/src/transport/lane-parser.ts';
import { laneFrameFacts } from '../packages/runtime/src/transport/lane-codec.ts';

test('standard Socket.IO identities stay visible and payload arrives once as a binary attachment', () => {
  const packet = { type: 2, nsp: '/', id: 7, data: ['service:call', { payload: 'opaque'.repeat(1000) }] };
  const [header, body] = new laneParser.Encoder().encode(packet);
  if (typeof header !== 'string' || !Buffer.isBuffer(body)) throw new Error('expected binary packet');
  expect(header.startsWith('51-7[')).toBe(true);
  expect(header).not.toContain('opaque');
  expect(Buffer.byteLength(header)).toBeLessThan(128);
  const decoder = new laneParser.Decoder();
  const seen: unknown[] = [];
  decoder.on('decoded', (value) => seen.push(value));
  decoder.add(header);
  expect(seen).toHaveLength(0);
  decoder.add(body);
  expect(seen).toEqual([packet]);
  expect(laneFrameFacts(body)?.encodedBytes).toBe(Buffer.byteLength(header) + body.length);
  const [ackHeader, ackBody] = new laneParser.Encoder().encode({
    type: 3,
    nsp: '/',
    id: 7,
    data: [{ ok: true }],
  });
  expect(typeof ackHeader === 'string' && ackHeader.startsWith('61-7[')).toBe(true);
  decoder.add(ackHeader);
  decoder.add(ackBody);
  expect(seen.at(-1)).toEqual({ type: 3, nsp: '/', id: 7, data: [{ ok: true }] });
});

test('identity mismatch, extra attachments, legacy payload and oversized header fail closed', () => {
  const [header, body] = new laneParser.Encoder().encode({ type: 2, nsp: '/', id: 7, data: ['event', {}] });
  if (typeof header !== 'string') throw new Error('expected header');
  const mismatched = new laneParser.Decoder();
  mismatched.add(header.replace('51-7', '51-8'));
  expect(() => mismatched.add(body)).toThrow('identity mismatch');
  const multiple = new laneParser.Decoder();
  expect(() => multiple.add('52-["event",{"_placeholder":true,"num":0}]')).toThrow();
  const legacy = new laneParser.Decoder();
  expect(() => legacy.add('2["event",{}]')).toThrow('binary frame');
  expect(() => new laneParser.Decoder().add('0'.repeat(4097))).toThrow('header exceeds');
  const destroyed = new laneParser.Decoder();
  destroyed.add(header);
  destroyed.destroy();
  expect(() => destroyed.add(body)).toThrow();
});
