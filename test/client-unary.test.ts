import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createWireClient, WireClientError } from '../packages/client/src/index.ts';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';
import { MAX_COMMAND_TIMEOUT_MS } from '../packages/contracts/src/protocol/bounds.ts';
import { deferred, result, withDoor } from './client-fixture.ts';

test('quiet command response uses its operation budget, not the stream-opening budget', async () => {
  await withDoor(
    (request, response) => {
      let body = '';
      request.on('data', (part) => {
        body += part;
      });
      request.on('end', () => {
        expect(JSON.parse(body).timeoutMs).toBe(MAX_COMMAND_TIMEOUT_MS);
        const timer = setTimeout(() => {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(result()));
        }, 150);
        response.on('close', () => clearTimeout(timer));
      });
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath, openTimeoutMs: 40 });
      expect(
        (await client.call({ to: 'worker', argv: ['read'], timeoutMs: MAX_COMMAND_TIMEOUT_MS })).failure,
      ).toBe('none');
    },
  );
});

test('short status deadline stays independent while a quiet command is pending', async () => {
  await withDoor(
    (request, response) => {
      if (request.url !== '/wire/call') return;
      const timer = setTimeout(() => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result()));
      }, 150);
      response.on('close', () => clearTimeout(timer));
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath, openTimeoutMs: 40 });
      const pending = client.call({ to: 'worker', argv: ['read'], timeoutMs: 1000 });
      await expect(client.status()).rejects.toMatchObject({ code: 'timeout', delivery: 'unknown' });
      expect((await pending).failure).toBe('none');
    },
  );
});

test('caller withdrawal still cancels quiet unary work without replay', async () => {
  let requests = 0;
  await withDoor(
    (_request, _response) => {
      requests++;
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath, openTimeoutMs: 40 });
      await expect(
        client.call(
          { to: 'worker', argv: ['read'], timeoutMs: MAX_COMMAND_TIMEOUT_MS },
          { signal: AbortSignal.timeout(100) },
        ),
      ).rejects.toMatchObject({
        code: 'cancelled',
        delivery: 'unknown',
        metadata: { cancellationOrigin: 'caller-abort' },
      });
      expect(requests).toBe(1);
    },
  );
});

test('RPC sends fixed local request, fills deadline and accepts additive response fields', async () => {
  await withDoor(
    (request, response) => {
      expect(request.url).toBe('/wire/call');
      let body = '';
      request.on('data', (part) => {
        body += part;
      });
      request.on('end', () => {
        expect(JSON.parse(body)).toEqual({ to: 'worker', argv: ['echo'], stdin: null, timeoutMs: 30_000 });
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result({ future: { enabled: true } })));
      });
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      const reply = await client.call({ to: 'worker', argv: ['echo'] });
      expect(reply.stdout).toBe('hello\n');
      expect(reply.failure).toBe('none');
      expect('future' in reply).toBe(false);
    },
  );
});

test('remote refusal and nonzero exit remain remote results, never local exceptions', async () => {
  for (const fields of [
    { failure: 'denied', refusal: 'capacity', retryAfterMs: 123, code: 1 },
    { code: 17 },
  ]) {
    await withDoor(
      (_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(result(fields)));
      },
      async (socketPath) => {
        using client = createWireClient({ socketPath });
        expect(await client.call({ to: 'worker', argv: ['echo'] })).toMatchObject(fields);
      },
    );
  }
});

test('foreign door version is distinguished from malformed JSON and shape', async () => {
  for (const [body, code] of [
    [JSON.stringify(result({ v: 3 })), 'version'],
    [JSON.stringify(result({ v: 6 })), 'version'],
    [JSON.stringify(result({ v: LOCAL_API_VERSION + 1 })), 'version'],
    ['{broken', 'invalid-response'],
    [JSON.stringify({ v: LOCAL_API_VERSION }), 'invalid-response'],
  ]) {
    await withDoor(
      (_request, response) => {
        response.setHeader('content-type', 'application/json');
        response.end(body);
      },
      async (socketPath) => {
        using client = createWireClient({ socketPath });
        await expect(client.call({ to: 'worker', argv: ['echo'] })).rejects.toMatchObject({
          code,
          delivery: 'unknown',
        });
      },
    );
  }
});

test('invalid requests and pre-aborted requests do not touch the socket', async () => {
  let requests = 0;
  await withDoor(
    (_request, response) => {
      requests++;
      response.end();
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      expect(() => client.call({ to: '../bad', argv: ['echo'] })).toThrow(WireClientError);
      expect(() => client.call({ to: 'worker', argv: [] })).toThrow(WireClientError);
      await expect(
        client.call({ to: 'worker', argv: ['echo'] }, { signal: AbortSignal.abort() }),
      ).rejects.toMatchObject({ code: 'cancelled', delivery: 'not-sent' });
      expect(requests).toBe(0);
    },
  );
});

test('missing socket is a local unavailable/not-sent error', async () => {
  const root = mkdtempSync('/tmp/wire-missing-');
  try {
    using client = createWireClient({ socketPath: `${root}/missing.sock` });
    await expect(client.status()).rejects.toMatchObject({ code: 'unavailable', delivery: 'not-sent' });
    symlinkSync(root, `${root}/alias`);
    using refused = createWireClient({ socketPath: `${root}/alias/missing.sock` });
    await expect(refused.status()).rejects.toMatchObject({ code: 'permission', delivery: 'not-sent' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('HTTP 404 is unsupported; non-JSON and oversize bodies are bounded failures', async () => {
  for (const scenario of [
    { status: 404, type: 'application/json', body: '{}', code: 'unsupported' },
    { status: 500, type: 'application/json', body: '{}', code: 'http' },
    { status: 200, type: 'text/html', body: '<html/>', code: 'invalid-response' },
    { status: 200, type: 'application/json', body: 'x'.repeat(101), code: 'limit' },
  ]) {
    await withDoor(
      (_request, response) => {
        response.writeHead(scenario.status, { 'content-type': scenario.type });
        response.end(scenario.body);
      },
      async (socketPath) => {
        using client = createWireClient({ socketPath, maxResponseBytes: 100 });
        await expect(client.status()).rejects.toMatchObject({ code: scenario.code });
      },
    );
  }
});

test('absolute deadline covers a response that keeps dripping bytes', async () => {
  await withDoor(
    (request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      const timer = setInterval(() => response.write(' '), 5);
      response.on('close', () => clearInterval(timer));
      request.on('aborted', () => clearInterval(timer));
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath, openTimeoutMs: 40 });
      const failure = await client.status().catch((error: unknown) => error);
      expect(failure).toMatchObject({
        code: 'timeout',
        delivery: 'unknown',
        metadata: { timing: { phase: 'body', timeoutMs: 40, callerAborted: false } },
      });
      if (!(failure instanceof WireClientError)) throw new Error('missing typed failure');
      expect(failure.metadata.timing?.headersMs).not.toBeNull();
      expect(failure.metadata.timing?.elapsedMs ?? 0).toBeGreaterThanOrEqual(30);
    },
  );
});

test('client caps concurrency and close aborts in-flight work and rejects new calls', async () => {
  const opened = deferred();
  await withDoor(
    (_request, _response) => opened.done(),
    async (socketPath) => {
      using client = createWireClient({ socketPath, maxConcurrentRequests: 1 });
      const first = client.status().catch((error: unknown) => error);
      await opened.promise;
      await expect(client.status()).rejects.toMatchObject({ code: 'capacity', delivery: 'not-sent' });
      client.close();
      expect(await first).toMatchObject({ code: 'closed', delivery: 'unknown' });
      await expect(client.status()).rejects.toMatchObject({ code: 'closed', delivery: 'not-sent' });
    },
  );
});

test('publication acknowledgement is unversioned and never automatically replayed', async () => {
  let requests = 0;
  await withDoor(
    (_request, response) => {
      requests++;
      response.setHeader('content-type', 'application/json');
      response.end('{unreadable');
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      await expect(
        client.publish({ topic: 'generic.events', bootId: crypto.randomUUID(), seq: 0, data: '{}' }),
      ).rejects.toMatchObject({ code: 'invalid-response', delivery: 'unknown' });
      expect(requests).toBe(1);
    },
  );
});

test('publication accepts additive ack fields and preserves capacity hint', async () => {
  await withDoor(
    (_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          ok: false,
          failure: 'denied',
          refusal: 'capacity',
          transportCause: null,
          retryAfterMs: 500,
          detail: 'busy',
          future: true,
        }),
      );
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      expect(
        await client.publish({ topic: 'generic.events', bootId: crypto.randomUUID(), seq: 0, data: '{}' }),
      ).toMatchObject({ ok: false, refusal: 'capacity', retryAfterMs: 500 });
    },
  );
});
