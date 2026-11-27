import { expect, test } from 'bun:test';
import { HandshakeRedial } from '../packages/runtime/src/node/handshake-redial.ts';

function clock() {
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  let id = 0;
  return {
    delays,
    pending,
    schedule(callback: () => void, delayMs: number) {
      const key = ++id;
      delays.push(delayMs);
      pending.set(key, callback);
      return () => {
        pending.delete(key);
      };
    },
    tick() {
      const entry = pending.entries().next().value;
      if (!entry) throw new Error('no scheduled retry');
      pending.delete(entry[0]);
      entry[1]();
    },
  };
}

test('refusal exponential backoff saturates at the declared ceiling, not three times it', () => {
  const time = clock();
  let dials = 0;
  const retry = new HandshakeRedial(
    100,
    250,
    () => {
      dials++;
    },
    time.schedule,
  );
  for (let attempt = 0; attempt < 6; attempt++) {
    retry.refused();
    retry.refused();
    expect(time.pending.size).toBe(1);
    time.tick();
  }
  expect(time.delays).toEqual([100, 200, 250, 250, 250, 250]);
  expect(dials).toBe(6);
});

test('connection cancels pending retry and resets backoff; stop rejects further scheduling', () => {
  const time = clock();
  let dials = 0;
  const retry = new HandshakeRedial(
    100,
    250,
    () => {
      dials++;
    },
    time.schedule,
  );
  retry.refused();
  time.tick();
  retry.refused();
  retry.connected();
  expect(time.pending.size).toBe(0);
  retry.refused();
  expect(time.delays).toEqual([100, 200, 100]);
  const staleCallback = time.pending.values().next().value;
  if (!staleCallback) throw new Error('missing pending timer');
  retry.stop();
  retry.stop();
  retry.refused();
  staleCallback();
  expect(time.pending.size).toBe(0);
  expect(dials).toBe(1);
});
