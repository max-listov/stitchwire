import { expect, test } from 'bun:test';
import { RemoteStreamCredit } from '../packages/runtime/src/node/stream-producer-credit.ts';

function credit() {
  return new RemoteStreamCredit({
    maxWindowBytes: 4,
    maxChunkBytes: 4,
    maxStreamBytes: 32,
    slowConsumerTimeoutMs: 1000,
  });
}

test('remote credit starts empty and only grants replenish consumed bytes', async () => {
  const window = credit();
  let ready = false;
  const waiting = window.wait(4).then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(window.grant(3)).toBe(true);
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(window.grant(1)).toBe(true);
  await waiting;
  expect(ready).toBe(true);
  window.consume(4);
  const blocked = window.wait(1);
  window.cancel('cancelled');
  await expect(blocked).rejects.toMatchObject({ reason: 'cancelled' });
});

test('over-grant is refused without changing available credit', async () => {
  const window = credit();
  expect(window.grant(3)).toBe(true);
  expect(window.grant(2)).toBe(false);
  let ready = false;
  const waiting = window.wait(4).then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(window.grant(1)).toBe(true);
  await waiting;
  expect(ready).toBe(true);
  window.cancel('cancelled');
});

test('cancellation wakes a silent credit wait and preserves the first terminal reason', async () => {
  const window = credit();
  const waiting = window.wait(1);
  window.cancel('timeout');
  window.cancel('cancelled');
  await expect(waiting).rejects.toMatchObject({ reason: 'timeout' });
  expect(window.grant(1)).toBe(false);
  await expect(window.wait(1)).rejects.toMatchObject({ reason: 'timeout' });
});
