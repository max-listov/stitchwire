import { expect, test } from 'bun:test';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';
import { createWireClient } from '../packages/client/src/index.ts';
import { withDoor, chunk, end, deferred } from './client-fixture.ts';

test('stream decodes payload, validates sequence and yields explicit terminal', async () => {
  const frame = chunk();
  await withDoor(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const text = `\n${JSON.stringify({ ...frame, future: true })}\n${JSON.stringify(end(frame.streamId))}\n`;
      for (let i = 0; i < text.length; i += 7) response.write(text.slice(i, i + 7));
      response.end();
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      const feed = client.stream({ to: 'worker', profile: 'logs' });
      const first = await feed.next();
      expect(first.value?.kind).toBe('chunk');
      if (!first.done && first.value.kind === 'chunk')
        expect(new TextDecoder().decode(first.value.data)).toBe('hello');
      expect((await feed.next()).value?.kind).toBe('end');
      expect((await feed.next()).done).toBe(true);
    },
  );
});

test('corrupt base64, byte count, identity, sequence and terminal cannot look successful', async () => {
  const frame = chunk();
  for (const frames of [
    [{ ...frame, data: '%%%==' }],
    [{ ...frame, bytes: 4 }],
    [{ ...frame, seq: 2 }],
    [{ ...frame, from: 'intruder' }],
    [frame, end(crypto.randomUUID())],
    [frame, end(frame.streamId, 9)],
  ]) {
    await withDoor(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(frames.map((f) => `${JSON.stringify(f)}\n`).join(''));
      },
      async (socketPath) => {
        using client = createWireClient({ socketPath });
        const read = async () => {
          for await (const _item of client.stream({ to: 'worker', profile: 'logs' })) {
          }
        };
        await expect(read()).rejects.toMatchObject({ code: 'invalid-response' });
      },
    );
  }
});

test('unterminated line and EOF without stream terminal are explicit failures', async () => {
  for (const body of [JSON.stringify(chunk()), `${JSON.stringify(chunk())}\n`, '\n']) {
    await withDoor(
      (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        response.end(body);
      },
      async (socketPath) => {
        using client = createWireClient({ socketPath });
        const read = async () => {
          for await (const _item of client.stream({ to: 'worker', profile: 'logs' })) {
          }
        };
        await expect(read()).rejects.toMatchObject({ code: 'unexpected-eof' });
      },
    );
  }
});

test('NDJSON bytes are bounded before a newline arrives', async () => {
  await withDoor(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write('x'.repeat(129));
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath, maxFrameBytes: 128 });
      await expect(client.stream({ to: 'worker', profile: 'logs' }).next()).rejects.toMatchObject({
        code: 'limit',
      });
    },
  );
});

test('quiet feed return cancels a pending next and closes the actual socket', async () => {
  const opened = deferred();
  const disconnected = deferred();
  await withDoor(
    (request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.flushHeaders();
      request.once('aborted', disconnected.done);
      response.write('\n');
      opened.done();
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      const feed = client.subscribe({ topic: 'generic.events' });
      const pending = feed.next().catch((error: unknown) => error);
      await opened.promise;
      await feed.return?.();
      expect(await pending).toMatchObject({ code: 'cancelled' });
      await disconnected.promise;
      expect((await feed.next()).done).toBe(true);
    },
  );
});

test('quiet event subscription survives open deadline; explicit abort still closes it', async () => {
  // The deadline itself is under test, so real time passes it. It must outlast how long a loaded host
  // can take to read headers the door already flushed: 20 ms did not, in 14 of 25 runs under full load.
  const openTimeoutMs = 500;
  const opened = deferred();
  await withDoor(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.flushHeaders();
      opened.done();
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath, openTimeoutMs });
      const cancel = new AbortController();
      let settled: unknown;
      const pending = client
        .subscribe({ topic: 'generic.events' }, { signal: cancel.signal })
        .next()
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await opened.promise;
      await Bun.sleep(openTimeoutMs + 60);
      expect(settled ? await pending : 'open').toBe('open');
      cancel.abort();
      expect(await pending).toMatchObject({ code: 'cancelled' });
    },
  );
});

test('events preserve gap reasons, successor boot and decoded payload without hidden resync', async () => {
  const subscriptionId = crypto.randomUUID();
  const bootId = crypto.randomUUID();
  const nextBootId = crypto.randomUUID();
  const event = {
    v: LOCAL_API_VERSION,
    subscriptionId,
    topic: 'generic.events',
    producer: 'worker',
    bootId: nextBootId,
    seq: 0,
    observedAt: null,
    cursor: 'owner-cursor',
    encoding: 'base64',
    data: 'e30=',
    bytes: 2,
  };
  const gap = {
    v: LOCAL_API_VERSION,
    subscriptionId,
    topic: 'generic.events',
    producer: 'worker',
    bootId,
    fromSeq: 9,
    toSeq: 10,
    reason: 'boot-change',
    nextBootId,
  };
  let calls = 0;
  await withDoor(
    (_request, response) => {
      calls++;
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(`${JSON.stringify(gap)}\n${JSON.stringify(event)}\n`);
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      const feed = client.subscribe({ topic: 'generic.events', resume: { bootId, afterSeq: 8 } });
      expect((await feed.next()).value).toMatchObject({
        kind: 'gap',
        frame: { nextBootId, reason: 'boot-change' },
      });
      expect((await feed.next()).value).toMatchObject({
        kind: 'event',
        frame: { cursor: 'owner-cursor', seq: 0 },
      });
      await feed.return?.();
      expect(calls).toBe(1);
    },
  );
});

test('client close during quiet read and concurrent next have bounded explicit outcomes', async () => {
  const opened = deferred();
  await withDoor(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.flushHeaders();
      opened.done();
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      const feed = client.subscribe({ topic: 'generic.events' });
      const first = feed.next().catch((error: unknown) => error);
      await opened.promise;
      await expect(feed.next()).rejects.toMatchObject({ code: 'capacity' });
      client.close();
      expect(await first).toMatchObject({ code: 'closed' });
    },
  );
});

test('abort at a yielded frame releases the client slot without requiring another next', async () => {
  await withDoor(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(`${JSON.stringify(chunk())}\n`);
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath, maxConcurrentRequests: 1 });
      const controller = new AbortController();
      const first = client.stream({ to: 'worker', profile: 'logs' }, { signal: controller.signal });
      expect((await first.next()).value?.kind).toBe('chunk');
      controller.abort();
      const second = client.stream({ to: 'worker', profile: 'logs' });
      expect((await second.next()).value?.kind).toBe('chunk');
      await first.return?.();
      await second.return?.();
    },
  );
});

test('slow reader applies backpressure instead of collecting an entire feed', async () => {
  let writes = 0;
  let stopped = false;
  const data = Buffer.alloc(32 * 1024, 120).toString('base64');
  const base = chunk();
  await withDoor(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const pump = (): void => {
        while (!stopped && writes < 512) {
          const line = `${JSON.stringify({ ...base, seq: writes++, data, bytes: 32 * 1024 })}\n`;
          if (!response.write(line)) return;
        }
      };
      response.on('drain', pump);
      pump();
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      const feed = client.stream({ to: 'worker', profile: 'logs' });
      expect((await feed.next()).value?.kind).toBe('chunk');
      await Bun.sleep(50);
      expect(writes).toBeLessThan(512);
      stopped = true;
      await feed.return?.();
    },
  );
});

test('terminal frees the only slot before yield and ignores trailing frames without replay', async () => {
  let requests = 0;
  await withDoor(
    (_request, response) => {
      requests++;
      const frame = chunk();
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(`${JSON.stringify(end(frame.streamId, -1))}\n${JSON.stringify(frame)}\n`);
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath, maxConcurrentRequests: 1 });
      const first = client.stream({ to: 'worker', profile: 'logs' });
      expect((await first.next()).value?.kind).toBe('end');
      const second = client.stream({ to: 'worker', profile: 'logs' });
      expect((await second.next()).value?.kind).toBe('end');
      expect((await first.next()).done).toBe(true);
      expect((await second.next()).done).toBe(true);
      expect(requests).toBe(2);
    },
  );
});
