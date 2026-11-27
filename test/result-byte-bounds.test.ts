import { expect, test } from 'bun:test';
import { ResultSchema } from '../packages/contracts/src/protocol/rpc.ts';
import { LocalResultSchema } from '../packages/contracts/src/door/results.ts';
import { CallResultSchema } from '../packages/local-client/src/readers.ts';
import { MAX_STREAM_BYTES } from '../packages/contracts/src/protocol/bounds.ts';
import { result } from './client-fixture.ts';

test('wire, door and forward-compatible SDK readers enforce the same UTF-8 result byte bounds', () => {
  const valid = result({ stdout: '🦎'.repeat(MAX_STREAM_BYTES / 4) });
  const invalid = result({ stdout: '🦎'.repeat(MAX_STREAM_BYTES / 2) });
  const { v: _v1, ...wireValid } = valid;
  const { v: _v2, ...wireInvalid } = invalid;
  expect(ResultSchema.safeParse(wireValid).success).toBe(true);
  expect(ResultSchema.safeParse(wireInvalid).success).toBe(false);
  expect(LocalResultSchema.safeParse({ ...wireValid, v: valid.v }).success).toBe(true);
  expect(LocalResultSchema.safeParse(invalid).success).toBe(false);
  expect(CallResultSchema.safeParse({ ...valid, future: 'ignored' }).success).toBe(true);
  expect(CallResultSchema.safeParse(invalid).success).toBe(false);
});
