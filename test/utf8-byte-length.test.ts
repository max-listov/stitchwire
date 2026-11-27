import { expect, test } from 'bun:test';
import { utf8ByteLength } from '../packages/contracts/src/protocol/payload.ts';

const encoder = new TextEncoder();
/** The count is held to what an encoder writes, on the inputs where counting goes wrong. */
const SLICE = Math.floor((64 * 1024) / 3);

test('the UTF-8 length is what an encoder writes, across slice boundaries and lone surrogates', () => {
  const pair = '😀';
  const cases = [
    '',
    'ascii',
    'ё',
    '€',
    pair,
    '\ud800',
    '\udc00',
    `a\ud800b`,
    `${'x'.repeat(SLICE - 1)}${pair}`,
    `${'x'.repeat(SLICE - 1)}\ud800`,
    `${'x'.repeat(SLICE)}${pair}`,
    pair.repeat(SLICE),
    'ё€😀'.repeat(50_000),
  ];
  for (const value of cases)
    expect({ units: value.length, bytes: utf8ByteLength(value) }).toEqual({
      units: value.length,
      bytes: encoder.encode(value).byteLength,
    });
});
