import { expect, test } from 'bun:test';
import { DEFAULT_REPEAT_WINDOW_MS, repeatLimited } from 'stitchkit/observability';

/** The clock is injected: the window is crossed by moving it, not by waiting. */
function logger() {
  let at = 1_000_000;
  const written: Array<{ message: string; data: Record<string, unknown> }> = [];
  const write = (message: string, data?: Record<string, unknown>) =>
    written.push({ message, data: data ?? {} });
  const sink = repeatLimited({ info: write, warn: write, error: write, debug: write }, { now: () => at });
  return { sink, written, advance: (ms: number) => (at += ms) };
}

const ownerFailure = (id: string) => ({
  service: 'owner.window',
  id,
  error: {
    _type: 'error',
    name: 'Error',
    code: 'ENOENT',
    message: `ENOENT: no such file or directory, lstat '/run/owner.sock'\n    at lstat`,
  },
});

test('a failure of one kind repeated thousands of times is written once, then counted', () => {
  const { sink, written, advance } = logger();
  for (let call = 0; call < 5_000; call++)
    sink.error('[wire:service] owner I/O failed', ownerFailure(`call-${call}`));
  expect(written).toHaveLength(1);
  expect(written[0]?.data.id).toBe('call-0');
  advance(DEFAULT_REPEAT_WINDOW_MS);
  sink.error('[wire:service] owner I/O failed', ownerFailure('call-5000'));
  expect(written).toHaveLength(2);
  expect(written[1]?.data.repeatedSinceLastWrite).toBe(4_999);
  expect(written[1]?.data.id).toBe('call-5000');
});

test('a different message, scope or cause is a different kind and is written at once', () => {
  const { sink, written } = logger();
  sink.error('[wire:service] owner I/O failed', ownerFailure('a'));
  sink.error('[wire:service] owner I/O failed', { ...ownerFailure('b'), service: 'owner.other' });
  sink.error('[wire:service] owner I/O failed', {
    ...ownerFailure('c'),
    error: { code: 'EACCES', message: 'EACCES' },
  });
  sink.error('[wire] connection failed', { lane: 'dev', error: { message: 'timeout' } });
  sink.error('[wire] connection failed', { lane: 'prod', error: { message: 'timeout' } });
  expect(written).toHaveLength(5);
});

test('information is never held back, and a kind that stopped is written plainly when it returns', () => {
  const { sink, written, advance } = logger();
  for (let index = 0; index < 3; index++) sink.info('[wire] lane connection changed', { lane: 'dev' });
  expect(written).toHaveLength(3);
  sink.warn('[wire] subscription lost', { lane: 'dev' });
  advance(DEFAULT_REPEAT_WINDOW_MS);
  sink.warn('[wire] subscription lost', { lane: 'dev' });
  expect(written.at(-1)?.data.repeatedSinceLastWrite).toBeUndefined();
});

test('a different reason, path or refusal in the data is a different kind, and a number in the message is not', () => {
  const { sink, written } = logger();
  sink.error('[wire] audit record refused', { reason: 'A' });
  sink.error('[wire] audit record refused', { reason: 'B' });
  sink.error('[wire] bundle refused', { refused: [{ service: 'a', detail: 'outside' }] });
  sink.error('[wire] bundle refused', { refused: [{ service: 'b', detail: 'outside' }] });
  expect(written).toHaveLength(4);
  for (const delay of [241, 210, 228])
    sink.error(`[wire] subscription lost; attempt ${delay % 7}, retrying in ${delay}ms`, { lane: 'dev' });
  expect(written).toHaveLength(5);
});

test('the kinds remembered are bounded to the most recent 256', () => {
  const { sink, written } = logger();
  for (let kind = 0; kind < 1_000; kind++) sink.error('[wire] failed', { resource: `resource-${kind}` });
  expect(written).toHaveLength(1_000);
  // The latest kind is still remembered, so it is held back; the first was evicted, so it is written again.
  sink.error('[wire] failed', { resource: 'resource-999' });
  expect(written).toHaveLength(1_000);
  sink.error('[wire] failed', { resource: 'resource-744' });
  expect(written).toHaveLength(1_000);
  // Both recently repeated kinds remain live: eviction uses last access.
  sink.error('[wire] failed', { resource: 'resource-743' });
  expect(written).toHaveLength(1_001);
  sink.error('[wire] failed', { resource: 'resource-744' });
  expect(written).toHaveLength(1_001);
  sink.error('[wire] failed', { resource: 'resource-0' });
  expect(written).toHaveLength(1_002);
});

test('data that is absent or not an object still carries the count', () => {
  const { sink, written, advance } = logger();
  for (let call = 0; call < 3; call++) sink.error('[wire] bare failure');
  advance(DEFAULT_REPEAT_WINDOW_MS);
  sink.error('[wire] bare failure');
  expect(written).toHaveLength(2);
  expect(written[1]?.data).toEqual({ repeatedSinceLastWrite: 2 });
});

test('a failure that differs only by per-call identifiers is one kind', () => {
  const { sink, written } = logger();
  for (let call = 0; call < 100; call++)
    sink.error('[wire:service] stream failed', {
      service: 'owner.window',
      streamId: `stream-${call}`,
      spanId: `span-${call}`,
      userId: `user-${call}`,
      dimensions: { call },
      attempt: call,
      error: { code: 'EPIPE', message: 'EPIPE' },
    });
  expect(written).toHaveLength(1);
  expect(written[0]?.data.streamId).toBe('stream-0');
});

test('a field that merely ends in the letters id is still part of the kind', () => {
  const { sink, written } = logger();
  sink.error('[wire] rejected', { valid: 'a', error: { message: 'x' } });
  sink.error('[wire] rejected', { valid: 'b', error: { message: 'x' } });
  expect(written).toHaveLength(2);
});

test('a kind evicted for room writes the count it holds instead of dropping it', () => {
  const { sink, written } = logger();
  sink.error('[wire] first kind', { lane: 'first' });
  for (let repeat = 0; repeat < 7; repeat++) sink.error('[wire] first kind', { lane: 'first' });
  for (let kind = 0; kind < 256; kind++) sink.error('[wire] other kind', { lane: `lane-${kind}` });
  const flushed = written.find(
    (entry) => entry.message === '[wire] first kind' && entry.data.repeatedSinceLastWrite !== undefined,
  );
  expect(flushed?.data.repeatedSinceLastWrite).toBe(7);
});

test('a cause with a code is one kind whatever its message says about the call', () => {
  const { sink, written } = logger();
  // The operating system names the socket of each call in the text; the code is the failure.
  for (let call = 0; call < 10; call++)
    sink.error('[wire:service] owner I/O failed', {
      service: 'owner.window',
      error: {
        code: 'ENOENT',
        message: `ENOENT: no such file or directory, connect '/run/owner-${call}.sock'`,
      },
    });
  expect(written).toHaveLength(1);
  // Negative control: another code under the same text is another failure, written at once.
  sink.error('[wire:service] owner I/O failed', {
    service: 'owner.window',
    error: { code: 'EACCES', message: `EACCES: permission denied, connect '/run/owner-0.sock'` },
  });
  expect(written).toHaveLength(2);
});
