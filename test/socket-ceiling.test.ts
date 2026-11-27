import { expect, test } from 'bun:test';
import { SocketCeiling } from '../packages/runtime/src/service/socket-ceiling.ts';

test('a socket runs at most the ceiling the new call brings, and a release counts once', () => {
  const ceiling = new SocketCeiling();
  const first = ceiling.acquire('/run/owner.sock', 2);
  const second = ceiling.acquire('/run/owner.sock', 2);
  expect([first === null, second === null]).toEqual([false, false]);
  expect(ceiling.acquire('/run/owner.sock', 2)).toBeNull();
  // Another socket has its own count.
  expect(ceiling.acquire('/run/other.sock', 1)).not.toBeNull();
  // A lowered ceiling applies to what is already running; a raised one admits at once.
  expect(ceiling.acquire('/run/owner.sock', 1)).toBeNull();
  expect(ceiling.acquire('/run/owner.sock', 3)).not.toBeNull();
  // Three calls run on the socket. A release counts once: released twice, two calls still run.
  first?.();
  first?.();
  expect(ceiling.acquire('/run/owner.sock', 2)).toBeNull();
  second?.();
  expect(ceiling.acquire('/run/owner.sock', 2)).not.toBeNull();
  // A socket nobody runs keeps no entry: a long-lived process does not grow with every socket it saw.
  expect(ceiling.busy).toBe(2);
  const lone = ceiling.acquire('/run/lone.sock', 1);
  expect(ceiling.busy).toBe(3);
  lone?.();
  expect(ceiling.busy).toBe(2);
});
