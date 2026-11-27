import { expect, test } from 'bun:test';
import { createWireClient } from '../packages/client/src/index.ts';
import { withDoor } from './client-fixture.ts';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';

function state(subscriptionId: string, subscriptionState: 'opening' | 'ready', lanes: string[]) {
  return { v: LOCAL_API_VERSION, subscriptionId, topic: 'test.quiet', subscriptionState, lanes };
}

test('HTTP headers and blank keepalive never confirm quiet admission or clear open timeout', async () => {
  let received = false;
  await withDoor(
    (_request, response) => {
      received = true;
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write('\n');
    },
    async (socketPath) => {
      // Long enough for a loaded host to reach the door inside the deadline under test.
      using client = createWireClient({ socketPath, openTimeoutMs: 500 });
      const feed = client.subscribe({ topic: 'test.quiet', lifecycle: true });
      await expect(feed.next()).rejects.toMatchObject({ code: 'timeout' });
      expect(received).toBe(true);
      await feed.return();
    },
  );
});

test('admitted but unacknowledged quiet handle remains bounded; ready removes that deadline', async () => {
  let attempt = 0;
  const id = crypto.randomUUID();
  await withDoor(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(`${JSON.stringify(state(id, 'opening', []))}\n`);
      if (++attempt === 2) response.write(`${JSON.stringify(state(id, 'ready', ['lane']))}\n`);
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath, openTimeoutMs: 100, maxConcurrentRequests: 1 });
      const first = client.subscribe({ topic: 'test.quiet', lifecycle: true });
      expect(await first.next()).toMatchObject({
        value: { kind: 'subscription', frame: { subscriptionState: 'opening' } },
      });
      await expect(first.next()).rejects.toMatchObject({ code: 'timeout' });
      const second = client.subscribe({ topic: 'test.quiet', lifecycle: true });
      await second.next();
      expect(await second.next()).toMatchObject({ value: { frame: { subscriptionState: 'ready' } } });
      const pending = second.next().catch((error: unknown) => error);
      await Bun.sleep(150);
      second.close();
      expect(await pending).toMatchObject({ code: 'cancelled' });
      await second.return();
    },
  );
});

test('subscription identity and readiness assertions are validated, including same-topic substitution', async () => {
  for (const invalid of [
    state(crypto.randomUUID(), 'ready', []),
    state(crypto.randomUUID(), 'ready', ['lane']),
  ]) {
    await withDoor(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(
          `${JSON.stringify(state(crypto.randomUUID(), 'opening', []))}\n${JSON.stringify(invalid)}\n`,
        );
      },
      async (socketPath) => {
        using client = createWireClient({ socketPath });
        const feed = client.subscribe({ topic: 'test.quiet', lifecycle: true });
        await feed.next();
        await expect(feed.next()).rejects.toMatchObject({ code: 'invalid-response' });
      },
    );
  }
});

test('cancel before first read sends nothing and has no pending lifecycle or admission', async () => {
  let requests = 0;
  await withDoor(
    (_request, response) => {
      requests++;
      response.end();
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath, maxConcurrentRequests: 1 });
      const feed = client.subscribe({ topic: 'test.quiet', lifecycle: true });
      feed.close();
      expect(await feed.next()).toEqual({ done: true, value: undefined });
      expect(await feed.return()).toEqual({ done: true, value: undefined });
      expect(requests).toBe(0);
    },
  );
});
