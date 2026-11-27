import { expect, test } from 'bun:test';
import { readJson } from '../packages/local-client/src/http.ts';

test('bounded body accepts exact byte ceiling across split UTF-8 chunks', async () => {
  const bytes = new TextEncoder().encode('"ж"');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 2));
      controller.enqueue(bytes.subarray(2));
      controller.close();
    },
  });
  expect(await readJson(new Response(body), bytes.length)).toBe('ж');
  expect(body.locked).toBe(false);
});

test('overflow cancels the source and retains Wire limit classification when cleanup rejects', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
    },
    cancel() {
      cancelled = true;
      throw new Error('cleanup failed');
    },
  });
  await expect(readJson(new Response(body), 4)).rejects.toMatchObject({ code: 'limit', delivery: 'unknown' });
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
});

test('source errors survive body cleanup and invalid UTF-8 remains invalid-response', async () => {
  const failure = new Error('source failed');
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(failure);
    },
  });
  await expect(readJson(new Response(body), 4)).rejects.toBe(failure);
  expect(body.locked).toBe(false);
  await expect(readJson(new Response(new Uint8Array([34, 255, 34])), 3)).rejects.toMatchObject({
    code: 'invalid-response',
    delivery: 'unknown',
  });
});
