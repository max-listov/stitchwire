import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createWireClient, LOCAL_API_VERSION } from '@stitchwire/client';
import { line, openDoor, runtime } from './_door.mjs';

let tcpRequests = 0;
const sentinel = createServer((_request, response) => {
  tcpRequests++;
  response.end('TCP must never carry a Wire request');
});
await new Promise((resolve, reject) => {
  sentinel.once('error', reject);
  sentinel.listen(0, '127.0.0.1', resolve);
});
const address = sentinel.address();
assert.ok(address && typeof address !== 'string');
const sentinelUrl = `http://127.0.0.1:${address.port}`;
const streamId = crypto.randomUUID();
const subscriptionId = crypto.randomUUID();
const bootId = crypto.randomUUID();
let openedResolve;
const opened = new Promise((resolve) => {
  openedResolve = resolve;
});
let calls = 0;
const door = await openDoor('consumer', (request, response) => {
  calls++;
  if (request.url === '/wire/status') {
    response.writeHead(307, { location: `${sentinelUrl}/wire/status` });
    response.end();
  } else if (request.url === '/wire/call') {
    const timer = setTimeout(() => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          v: LOCAL_API_VERSION,
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          from: 'worker',
          code: 0,
          stdout: 'packed',
          stderr: '',
          failure: 'none',
          refusal: 'none',
          transportCause: null,
          retryAfterMs: null,
          detail: '',
          truncated: false,
        }),
      );
    }, 150);
    response.on('close', () => clearTimeout(timer));
  } else if (request.url === '/wire/events/publish') {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        ok: true,
        failure: 'none',
        refusal: 'none',
        transportCause: null,
        retryAfterMs: null,
        detail: '',
        additive: 1,
      }),
    );
  } else if (request.url === '/wire/stream') {
    response.setHeader('content-type', 'application/x-ndjson');
    response.end(
      line({
        v: LOCAL_API_VERSION,
        streamId,
        from: 'worker',
        lastSeq: -1,
        code: 0,
        reason: 'completed',
        cursor: null,
      }),
    );
  } else if (request.url === '/wire/events/subscribe') {
    response.setHeader('content-type', 'application/x-ndjson');
    response.write(
      line({
        v: LOCAL_API_VERSION,
        subscriptionId,
        topic: 'generic.events',
        producer: 'worker',
        bootId,
        seq: 0,
        observedAt: null,
        cursor: null,
        encoding: 'base64',
        data: 'e30=',
        bytes: 2,
      }),
    );
    openedResolve();
  } else {
    response.writeHead(404);
    response.end();
  }
});
// The stream-opening deadline is shorter than the quiet RPC's answer only on its own client: a stream
// opened under a 40 ms deadline would fail whenever a loaded host delays its headers, and the steps
// after the first are about the stream, event and slot API, not about that deadline.
const quiet = createWireClient({ socketPath: door.socketPath, maxConcurrentRequests: 1, openTimeoutMs: 40 });
const client = createWireClient({ socketPath: door.socketPath, maxConcurrentRequests: 1 });
try {
  try {
    assert.equal((await quiet.call({ to: 'worker', argv: ['read'] })).stdout, 'packed');
  } finally {
    quiet.close();
  }
  console.log('packed quiet RPC survives stream-opening timeout');
  assert.equal((await client.publish({ topic: 'generic.events', bootId, seq: 0, data: '{}' })).ok, true);
  console.log('packed publication verified');
  const stream = client.stream({ to: 'worker', profile: 'logs' });
  assert.equal((await stream.next()).value.kind, 'end');
  assert.equal((await stream.next()).done, true);
  console.log('packed stream verified');
  const events = client.subscribe({ topic: 'generic.events' });
  const event = await events.next();
  assert.equal(event.value.kind, 'event');
  assert.equal(new TextDecoder().decode(event.value.data), '{}');
  console.log('packed event verified');
  await opened;
  const pending = events.next().catch((error) => error);
  await events.return();
  assert.equal((await pending).code, 'cancelled');
  console.log('packed pending read cancelled');
  // Real agent admission release is proved in client-integration.test.ts; this fixture
  // checks the installed package's read/cancel API on both runtimes.
  assert.equal(calls, 4);
  const abort = new AbortController();
  const cancelledFeed = client.subscribe({ topic: 'generic.events' }, { signal: abort.signal });
  assert.equal((await cancelledFeed.next()).value.kind, 'event');
  const cancelledRead = cancelledFeed.next().catch((error) => error);
  abort.abort();
  assert.equal((await cancelledRead).code, 'cancelled');
  assert.equal((await client.call({ to: 'worker', argv: ['read'] })).stdout, 'packed');
  assert.equal(calls, 6);
  console.log('packed post-header caller abort releases the only client slot');
  // The redirect names a real accepting TCP server: zero hits is not a closed-port artifact.
  await fetch(sentinelUrl);
  assert.equal(tcpRequests, 1);
  tcpRequests = 0;
  await assert.rejects(client.status(), { code: 'http', delivery: 'unknown' });
  const missing = createWireClient({ socketPath: join(door.root, 'missing.sock') });
  try {
    await assert.rejects(missing.status(), { code: 'unavailable', delivery: 'not-sent' });
  } finally {
    missing.close();
  }
  assert.equal(tcpRequests, 0);
  assert.equal(calls, 7);
  console.log('packed Unix redirect sentinel and missing socket verified');
  console.log(
    JSON.stringify({
      runtime,
      packedClient: true,
      rpc: true,
      stream: true,
      publish: true,
      cancel: true,
      unixRedirectTcpRequests: tcpRequests,
      missingSocket: true,
    }),
  );
} finally {
  client.close();
  await door.close();
  sentinel.closeAllConnections();
  await new Promise((resolve) => sentinel.close(resolve));
}
